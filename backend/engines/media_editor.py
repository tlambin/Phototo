import os
import shutil
import subprocess
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageDraw, ImageFont
import exiftool
from media_frames import VIDEO_EXTS


def preserve_metadata_and_time(src_path: Path, target_path: Path, timestamp: int | None = None):
    try:
        with exiftool.ExifToolHelper() as et:
            et.execute(
                "-overwrite_original", "-P", "-q",
                "-tagsFromFile", str(src_path), "-all:all",
                str(target_path)
            )
    except Exception:
        pass
    ts = timestamp or int(src_path.stat().st_mtime)
    if target_path.exists():
        os.utime(target_path, (ts, ts))


def get_output_path(src_path: Path, overwrite: bool = False, suffix_tag: str = "_edit", ext_override: str | None = None) -> Path:
    """Par défaut (overwrite=False), génère toujours un nouveau fichier suffixé (_edit) sans écraser l'original."""
    ext = ext_override if ext_override else src_path.suffix
    if overwrite and not ext_override:
        return src_path
    counter = 1
    candidate = src_path.parent / f"{src_path.stem}{suffix_tag}{ext}"
    while candidate.exists():
        candidate = src_path.parent / f"{src_path.stem}{suffix_tag}_{counter}{ext}"
        counter += 1
    return candidate


def process_image_edits(src_path: Path, ops: dict, overwrite: bool = False, timestamp: int | None = None) -> Path:
    img = Image.open(src_path).convert("RGB")

    # 1. Gomme Magique (Inpainting Telea)
    inpaint_boxes = ops.get("inpaint_boxes") or []
    if inpaint_boxes:
        bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        h, w = bgr.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        for b in inpaint_boxes:
            x1, y1 = int(max(0, b["nx"] * w)), int(max(0, b["ny"] * h))
            x2, y2 = int(min(w, (b["nx"] + b["nw"]) * w)), int(min(h, (b["ny"] + b["nh"]) * h))
            cv2.rectangle(mask, (x1, y1), (x2, y2), 255, -1)
        mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=2)
        inpainted = cv2.inpaint(bgr, mask, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
        img = Image.fromarray(cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB))

    # 2. Rognage / Recadrage
    crop = ops.get("crop")
    if crop and crop.get("nw", 0) > 0.02 and crop.get("nh", 0) > 0.02:
        w, h = img.size
        left, top = int(max(0, crop["nx"] * w)), int(max(0, crop["ny"] * h))
        right, bottom = int(min(w, (crop["nx"] + crop["nw"]) * w)), int(min(h, (crop["ny"] + crop["nh"]) * h))
        if right - left > 10 and bottom - top > 10:
            img = img.crop((left, top, right, bottom))

    # 3. Rotation & Miroir
    rot = int(ops.get("rotate", 0)) % 360
    if rot == 90:
        img = img.transpose(Image.Transpose.ROTATE_270)
    elif rot == 180:
        img = img.transpose(Image.Transpose.ROTATE_180)
    elif rot == 270:
        img = img.transpose(Image.Transpose.ROTATE_90)

    if ops.get("flip_h"):
        img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if ops.get("flip_v"):
        img = img.transpose(Image.Transpose.FLIP_TOP_BOTTOM)

    # 4. Couleurs, Luminosité, Contraste, Netteté
    if ops.get("brightness", 1.0) != 1.0:
        img = ImageEnhance.Brightness(img).enhance(float(ops["brightness"]))
    if ops.get("contrast", 1.0) != 1.0:
        img = ImageEnhance.Contrast(img).enhance(float(ops["contrast"]))
    if ops.get("saturation", 1.0) != 1.0:
        img = ImageEnhance.Color(img).enhance(float(ops["saturation"]))
    if ops.get("sharpness", 1.0) != 1.0:
        img = ImageEnhance.Sharpness(img).enhance(float(ops["sharpness"]))

    # 5. Texte incrusté
    txt_cfg = ops.get("text_overlay")
    if txt_cfg and txt_cfg.get("text", "").strip():
        draw = ImageDraw.Draw(img)
        w, h = img.size
        font_size = max(14, int((txt_cfg.get("size", 36) / 1000.0) * max(w, h)))
        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()
        tx, ty = int(txt_cfg.get("nx", 0.05) * w), int(txt_cfg.get("ny", 0.88) * h)
        draw.text((tx + 2, ty + 2), txt_cfg["text"], font=font, fill="#000000")
        draw.text((tx, ty), txt_cfg["text"], font=font, fill=txt_cfg.get("color", "#ffffff"))

    out_path = get_output_path(src_path, overwrite=overwrite, suffix_tag="_edit")
    tmp_path = out_path.with_name(f".tmp_{out_path.name}")
    img.save(tmp_path, quality=95)
    preserve_metadata_and_time(src_path, tmp_path, timestamp)
    shutil.move(tmp_path, out_path)
    return out_path


def process_video_edits(src_path: Path, ops: dict, overwrite: bool = False, timestamp: int | None = None) -> list[Path]:
    mode = ops.get("video_action", "EDIT")
    cap = cv2.VideoCapture(str(src_path))
    vid_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    vid_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    cap.release()

    if mode == "SPLIT":
        split_sec = float(ops.get("split_time_sec", 5.0))
        part1 = get_output_path(src_path, overwrite=False, suffix_tag="_part1")
        part2 = get_output_path(src_path, overwrite=False, suffix_tag="_part2")
        subprocess.run(["ffmpeg", "-y", "-i", str(src_path), "-t", str(split_sec), "-c", "copy", str(part1)], check=True)
        subprocess.run(["ffmpeg", "-y", "-ss", str(split_sec), "-i", str(src_path), "-c", "copy", str(part2)], check=True)
        preserve_metadata_and_time(src_path, part1, timestamp)
        preserve_metadata_and_time(src_path, part2, (timestamp + int(split_sec)) if timestamp else None)
        return [part1, part2]

    if mode == "GIF":
        start_s = float(ops.get("start_sec", 0.0))
        end_s = float(ops.get("end_sec", 0.0))
        gif_out = get_output_path(src_path, overwrite=False, suffix_tag="_anim", ext_override=".gif")
        cmd = ["ffmpeg", "-y"]
        if start_s > 0:
            cmd.extend(["-ss", str(start_s)])
        if end_s > start_s:
            cmd.extend(["-to", str(end_s)])
        cmd.extend([
            "-i", str(src_path),
            "-vf", "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
            str(gif_out)
        ])
        subprocess.run(cmd, check=True)
        if timestamp:
            os.utime(gif_out, (timestamp, timestamp))
        return [gif_out]

    vf_filters, af_filters = [], []

    for b in (ops.get("inpaint_boxes") or []):
        bx, by = max(2, int(b["nx"] * vid_w)), max(2, int(b["ny"] * vid_h))
        bw, bh = min(vid_w - bx - 2, max(10, int(b["nw"] * vid_w))), min(vid_h - by - 2, max(10, int(b["nh"] * vid_h)))
        vf_filters.append(f"delogo=x={bx}:y={by}:w={bw}:h={bh}:show=0")

    crop = ops.get("crop")
    if crop and crop.get("nw", 0) > 0.02 and crop.get("nh", 0) > 0.02:
        cw, ch = int(crop["nw"] * vid_w) & ~1, int(crop["nh"] * vid_h) & ~1
        cx, cy = int(crop["nx"] * vid_w) & ~1, int(crop["ny"] * vid_h) & ~1
        if cw >= 32 and ch >= 32:
            vf_filters.append(f"crop={cw}:{ch}:{cx}:{cy}")

    rot = int(ops.get("rotate", 0)) % 360
    if rot == 90:
        vf_filters.append("transpose=1")
    elif rot == 180:
        vf_filters.append("transpose=1,transpose=1")
    elif rot == 270:
        vf_filters.append("transpose=2")

    if ops.get("flip_h"):
        vf_filters.append("hflip")
    if ops.get("flip_v"):
        vf_filters.append("vflip")

    b_val = float(ops.get("brightness", 1.0)) - 1.0
    c_val = float(ops.get("contrast", 1.0))
    s_val = float(ops.get("saturation", 1.0))
    if abs(b_val) > 0.01 or abs(c_val - 1.0) > 0.01 or abs(s_val - 1.0) > 0.01:
        vf_filters.append(f"eq=brightness={b_val:.2f}:contrast={c_val:.2f}:saturation={s_val:.2f}")

    txt_cfg = ops.get("text_overlay")
    if txt_cfg and txt_cfg.get("text", "").strip():
        safe_text = txt_cfg["text"].replace(":", "\\:").replace("'", "")
        fsize = max(18, int((txt_cfg.get("size", 36) / 1000.0) * max(vid_w, vid_h)))
        color = txt_cfg.get("color", "#ffffff")
        nx, ny = float(txt_cfg.get("nx", 0.05)), float(txt_cfg.get("ny", 0.88))
        vf_filters.append(
            f"drawtext=text='{safe_text}':x=w*{nx:.3f}:y=h*{ny:.3f}:fontsize={fsize}:fontcolor={color}:shadowcolor=black:shadowx=2:shadowy=2"
        )

    speed = float(ops.get("speed", 1.0))
    if abs(speed - 1.0) > 0.01 and 0.25 <= speed <= 4.0:
        vf_filters.append(f"setpts={1.0 / speed:.4f}*PTS")
        if speed < 0.5:
            af_filters.append(f"atempo=0.5,atempo={speed / 0.5:.2f}")
        elif speed > 2.0:
            af_filters.append(f"atempo=2.0,atempo={speed / 2.0:.2f}")
        else:
            af_filters.append(f"atempo={speed:.2f}")

    out_path = get_output_path(src_path, overwrite=overwrite, suffix_tag="_edit")
    tmp_path = out_path.with_name(f".tmp_{out_path.name}")

    cmd = ["ffmpeg", "-y"]
    start_s = float(ops.get("start_sec", 0.0))
    end_s = float(ops.get("end_sec", 0.0))
    if start_s > 0:
        cmd.extend(["-ss", str(start_s)])
    if end_s > start_s:
        cmd.extend(["-to", str(end_s)])
    cmd.extend(["-i", str(src_path)])

    custom_audio = (ops.get("custom_audio_path") or "").strip()
    mute_audio = bool(ops.get("mute_audio", False))
    if custom_audio and Path(custom_audio).exists():
        cmd.extend(["-i", custom_audio, "-map", "0:v:0", "-map", "1:a:0", "-shortest"])

    if vf_filters:
        cmd.extend(["-vf", ",".join(vf_filters)])
    if mute_audio:
        cmd.append("-an")
    elif af_filters and not custom_audio:
        cmd.extend(["-af", ",".join(af_filters)])

    if not vf_filters and not af_filters and not custom_audio:
        cmd.extend(["-c:v", "copy"])
        if not mute_audio:
            cmd.extend(["-c:a", "copy"])
    else:
        cmd.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-c:a", "aac"])

    cmd.append(str(tmp_path))
    subprocess.run(cmd, check=True)
    preserve_metadata_and_time(src_path, tmp_path, timestamp)
    shutil.move(tmp_path, out_path)
    return [out_path]