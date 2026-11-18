import sqlite3
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_db, log_library_action

router = APIRouter()

VALID_GROUP_SCOPES = {"albums", "persons", "places", "favorites"}


class CreateGroupPayload(BaseModel):
    scope: str
    name: str
    item_keys: list[str] = []
    color: str = ""


class RenameGroupPayload(BaseModel):
    group_id: int
    new_name: str


class DeleteGroupPayload(BaseModel):
    group_id: int


class SetGroupItemsPayload(BaseModel):
    group_id: int
    item_keys: list[str]
    mode: str = "replace"  # 'replace' | 'add' | 'remove'


class ReorderGroupsPayload(BaseModel):
    scope: str
    group_ids: list[int]


def _validate_scope(scope: str) -> str:
    s = (scope or "").strip().lower()
    if s not in VALID_GROUP_SCOPES:
        raise HTTPException(400, f"Portée de groupe invalide : {scope}")
    return s


def _fetch_group_dict(cur: sqlite3.Cursor, group_id: int) -> dict | None:
    row = cur.execute(
        "SELECT group_id, scope, name, color, sort_order, created_at FROM custom_groups WHERE group_id = ?",
        (group_id,),
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    keys = [
        r["item_key"]
        for r in cur.execute(
            "SELECT item_key FROM custom_group_items WHERE group_id = ? ORDER BY added_at ASC, item_key ASC",
            (group_id,),
        ).fetchall()
    ]
    d["item_keys"] = keys
    return d


@router.get("/api/groups")
def api_list_groups(scope: str | None = None):
    conn = get_db()
    cur = conn.cursor()
    if scope is not None:
        sc = _validate_scope(scope)
        rows = cur.execute(
            "SELECT group_id, scope, name, color, sort_order, created_at FROM custom_groups WHERE scope = ? ORDER BY COALESCE(sort_order, 0) ASC, LOWER(name) ASC, group_id ASC",
            (sc,),
        ).fetchall()
    else:
        rows = cur.execute(
            "SELECT group_id, scope, name, color, sort_order, created_at FROM custom_groups ORDER BY scope ASC, COALESCE(sort_order, 0) ASC, LOWER(name) ASC, group_id ASC"
        ).fetchall()

    groups = []
    items_by_gid: dict[int, list[str]] = {}
    if rows:
        gids = [r["group_id"] for r in rows]
        ph = ",".join("?" for _ in gids)
        for ir in cur.execute(
            f"SELECT group_id, item_key FROM custom_group_items WHERE group_id IN ({ph}) ORDER BY added_at ASC, item_key ASC",
            gids,
        ).fetchall():
            items_by_gid.setdefault(ir["group_id"], []).append(ir["item_key"])
    for r in rows:
        d = dict(r)
        d["item_keys"] = items_by_gid.get(r["group_id"], [])
        groups.append(d)
    conn.close()
    return {"groups": groups}


@router.post("/api/groups/create")
def api_create_group(payload: CreateGroupPayload):
    sc = _validate_scope(payload.scope)
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "Le nom du groupe ne peut pas être vide.")

    conn = get_db()
    cur = conn.cursor()
    existing = cur.execute(
        "SELECT group_id FROM custom_groups WHERE scope = ? AND LOWER(TRIM(name)) = LOWER(?)",
        (sc, name),
    ).fetchone()
    if existing:
        conn.close()
        raise HTTPException(409, "Un groupe portant ce nom existe déjà dans cette section.")

    next_order_row = cur.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_ord FROM custom_groups WHERE scope = ?",
        (sc,),
    ).fetchone()
    next_order = int(next_order_row["next_ord"] or 0) if next_order_row else 0
    cur.execute(
        "INSERT INTO custom_groups (scope, name, color, sort_order) VALUES (?, ?, ?, ?)",
        (sc, name, (payload.color or "").strip(), next_order),
    )
    gid = cur.lastrowid
    clean_keys = list(dict.fromkeys(str(k).strip() for k in (payload.item_keys or []) if str(k).strip()))
    for k in clean_keys:
        cur.execute("INSERT OR IGNORE INTO custom_group_items (group_id, item_key) VALUES (?, ?)", (gid, k))
    group_obj = _fetch_group_dict(cur, gid)
    conn.commit()
    conn.close()
    log_library_action("GROUP_CREATE", "Groupe créé", f"« {name} » ({sc}, {len(clean_keys)} élément(s))")
    return {"status": "created", "group": group_obj}


@router.post("/api/groups/rename")
def api_rename_group(payload: RenameGroupPayload):
    new_name = (payload.new_name or "").strip()
    if not new_name:
        raise HTTPException(400, "Le nom du groupe ne peut pas être vide.")

    conn = get_db()
    cur = conn.cursor()
    row = cur.execute("SELECT group_id, scope, name FROM custom_groups WHERE group_id = ?", (payload.group_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Groupe introuvable.")

    dup = cur.execute(
        "SELECT group_id FROM custom_groups WHERE scope = ? AND LOWER(TRIM(name)) = LOWER(?) AND group_id != ?",
        (row["scope"], new_name, payload.group_id),
    ).fetchone()
    if dup:
        conn.close()
        raise HTTPException(409, "Un autre groupe porte déjà ce nom.")

    cur.execute("UPDATE custom_groups SET name = ? WHERE group_id = ?", (new_name, payload.group_id))
    group_obj = _fetch_group_dict(cur, payload.group_id)
    conn.commit()
    conn.close()
    log_library_action("GROUP_RENAME", "Groupe renommé", f"« {row['name']} » → « {new_name} »")
    return {"status": "renamed", "group": group_obj}


@router.post("/api/groups/delete")
def api_delete_group(payload: DeleteGroupPayload):
    conn = get_db()
    cur = conn.cursor()
    row = cur.execute("SELECT group_id, scope, name FROM custom_groups WHERE group_id = ?", (payload.group_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Groupe introuvable.")

    cur.execute("DELETE FROM custom_group_items WHERE group_id = ?", (payload.group_id,))
    cur.execute("DELETE FROM custom_groups WHERE group_id = ?", (payload.group_id,))
    conn.commit()
    conn.close()
    log_library_action("GROUP_DELETE", "Groupe supprimé", f"« {row['name']} » ({row['scope']})")
    return {"status": "deleted", "group_id": payload.group_id}


@router.post("/api/groups/set_items")
def api_set_group_items(payload: SetGroupItemsPayload):
    mode = (payload.mode or "replace").strip().lower()
    if mode not in {"replace", "add", "remove"}:
        raise HTTPException(400, f"Mode invalide : {mode}")

    conn = get_db()
    cur = conn.cursor()
    row = cur.execute("SELECT group_id, scope, name FROM custom_groups WHERE group_id = ?", (payload.group_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Groupe introuvable.")

    clean_keys = list(dict.fromkeys(str(k).strip() for k in (payload.item_keys or []) if str(k).strip()))
    if mode == "replace":
        cur.execute("DELETE FROM custom_group_items WHERE group_id = ?", (payload.group_id,))
        for k in clean_keys:
            cur.execute("INSERT OR IGNORE INTO custom_group_items (group_id, item_key) VALUES (?, ?)", (payload.group_id, k))
    elif mode == "add":
        for k in clean_keys:
            cur.execute("INSERT OR IGNORE INTO custom_group_items (group_id, item_key) VALUES (?, ?)", (payload.group_id, k))
    elif mode == "remove":
        if clean_keys:
            ph = ",".join("?" for _ in clean_keys)
            cur.execute(
                f"DELETE FROM custom_group_items WHERE group_id = ? AND item_key IN ({ph})",
                [payload.group_id, *clean_keys],
            )

    group_obj = _fetch_group_dict(cur, payload.group_id)
    conn.commit()
    conn.close()
    return {"status": "updated", "group": group_obj}


@router.post("/api/groups/reorder")
def api_reorder_groups(payload: ReorderGroupsPayload):
    sc = _validate_scope(payload.scope)
    conn = get_db()
    cur = conn.cursor()
    for idx, gid in enumerate(payload.group_ids or []):
        cur.execute(
            "UPDATE custom_groups SET sort_order = ? WHERE group_id = ? AND scope = ?",
            (idx, gid, sc),
        )
    conn.commit()
    conn.close()
    return {"status": "reordered"}
