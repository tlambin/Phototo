import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request

_FR_EN_CACHE: dict[str, str] = {}
_OFFLINE_UNTIL: float = 0.0

_FR_PHRASES: list[tuple[str, str]] = [
    ("coucher de soleil", "sunset"),
    ("lever de soleil", "sunrise"),
    ("feu d artifice", "fireworks"),
    ("feux d artifice", "fireworks"),
    ("capture d ecran", "screenshot"),
    ("bord de mer", "seaside"),
    ("au bord de la mer", "by the sea"),
    ("pique nique", "picnic"),
    ("pique-nique", "picnic"),
    ("fete des meres", "mothers day"),
    ("fete des peres", "fathers day"),
    ("sapin de noel", "christmas tree"),
    ("pere noel", "santa claus"),
    ("nouvel an", "new year"),
    ("saint valentin", "valentines day"),
    ("parc d attractions", "amusement park"),
    ("plein air", "outdoors"),
    ("centre ville", "city center"),
    ("centre-ville", "city center"),
    ("vue aerienne", "aerial view"),
    ("noir et blanc", "black and white"),
    ("gros plan", "close up"),
    ("en famille", "with family"),
    ("entre amis", "with friends"),
    ("soiree entre amis", "party with friends"),
    ("sport d hiver", "winter sports"),
    ("sports d hiver", "winter sports"),
]

_FR_STOPWORDS = {
    "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "au", "aux",
    "et", "ou", "a", "en", "dans", "sur", "sous", "avec", "sans", "pour", "par",
    "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "nos", "vos",
    "photo", "photos", "image", "images",
}

_FR_EN_WORDS: dict[str, str] = {
    # Personnes & événements
    "famille": "family", "amis": "friends", "ami": "friend", "copains": "friends",
    "personne": "person", "personnes": "people", "gens": "people", "groupe": "group",
    "portrait": "portrait", "portraits": "portrait", "visage": "face", "visages": "faces",
    "sourire": "smile", "bebe": "baby", "bebes": "baby", "enfant": "child", "enfants": "children",
    "garcon": "boy", "fille": "girl", "homme": "man", "femme": "woman", "couple": "couple",
    "maman": "mother", "mere": "mother", "papa": "father", "pere": "father",
    "grandpere": "grandfather", "grandmere": "grandmother", "frere": "brother", "soeur": "sister",
    "anniversaire": "birthday", "mariage": "wedding", "bapteme": "baptism",
    "fete": "party", "fetes": "party", "soiree": "evening party", "vacances": "vacation",
    "noel": "christmas", "paques": "easter", "halloween": "halloween", "carnaval": "carnival",
    "cadeau": "gift", "cadeaux": "gifts", "bougie": "candle", "bougies": "candles",
    "diplome": "graduation", "reunion": "meeting", "concert": "concert", "festival": "festival",
    "spectacle": "show", "theatre": "theater", "cinema": "cinema",
    # Lieux & nature
    "nature": "nature", "paysage": "landscape", "montagne": "mountain", "montagnes": "mountains",
    "mer": "sea", "ocean": "ocean", "plage": "beach", "sable": "sand", "vague": "wave", "vagues": "waves",
    "lac": "lake", "riviere": "river", "fleuve": "river", "cascade": "waterfall", "eau": "water",
    "piscine": "swimming pool", "foret": "forest", "bois": "woods", "arbre": "tree", "arbres": "trees",
    "fleur": "flower", "fleurs": "flowers", "plante": "plant", "plantes": "plants",
    "jardin": "garden", "parc": "park", "campagne": "countryside", "champ": "field", "champs": "fields",
    "ciel": "sky", "nuage": "cloud", "nuages": "clouds", "soleil": "sun", "lune": "moon", "etoile": "star", "etoiles": "stars",
    "pluie": "rain", "orage": "storm", "neige": "snow", "glace": "ice", "brouillard": "fog",
    "arc": "rainbow", "nuit": "night", "matin": "morning", "soir": "evening",
    "printemps": "spring", "ete": "summer", "automne": "autumn", "hiver": "winter",
    # Ville & bâtiments
    "ville": "city", "rue": "street", "rues": "streets", "place": "square", "quartier": "neighborhood",
    "maison": "house", "appartement": "apartment", "chambre": "bedroom", "salon": "living room",
    "cuisine": "kitchen", "salle": "room", "bureau": "office", "ecole": "school",
    "eglise": "church", "cathedrale": "cathedral", "chateau": "castle", "monument": "monument",
    "musee": "museum", "restaurant": "restaurant", "cafe": "cafe", "bar": "bar", "hotel": "hotel",
    "magasin": "shop", "pont": "bridge", "tour": "tower", "immeuble": "building", "batiment": "building",
    # Animaux
    "animal": "animal", "animaux": "animals", "chien": "dog", "chiens": "dogs", "chiot": "puppy",
    "chat": "cat", "chats": "cats", "chaton": "kitten", "oiseau": "bird", "oiseaux": "birds",
    "cheval": "horse", "chevaux": "horses", "poisson": "fish", "papillon": "butterfly",
    "vache": "cow", "mouton": "sheep", "lapin": "rabbit", "lion": "lion",
    # Nourriture & boissons
    "nourriture": "food", "repas": "meal", "plat": "dish", "plats": "dishes",
    "gateau": "cake", "gateaux": "cakes", "dessert": "dessert", "glace": "ice cream",
    "pain": "bread", "fromage": "cheese", "viande": "meat", "legume": "vegetable", "legumes": "vegetables",
    "fruit": "fruit", "fruits": "fruits", "chocolat": "chocolate", "pizza": "pizza", "burger": "burger",
    "vin": "wine", "biere": "beer", "cocktail": "cocktail", "verre": "glass", "boisson": "drink", "the": "tea",
    # Transports & sports & loisirs
    "voiture": "car", "voitures": "cars", "moto": "motorcycle", "motos": "motorcycles",
    "velo": "bicycle", "velos": "bicycles", "train": "train", "avion": "airplane",
    "bateau": "boat", "bateaux": "boats", "bus": "bus", "camion": "truck", "route": "road",
    "voyage": "travel", "voyages": "travel", "aeroport": "airport", "gare": "train station",
    "sport": "sport", "football": "soccer", "foot": "soccer", "basket": "basketball",
    "tennis": "tennis", "natation": "swimming", "ski": "skiing", "randonnee": "hiking",
    "course": "running", "cyclisme": "cycling", "escalade": "climbing", "yoga": "yoga", "danse": "dance",
    "musique": "music", "guitare": "guitar", "piano": "piano", "jeu": "game", "jeux": "games",
    "livre": "book", "livres": "books", "peinture": "painting", "dessin": "drawing",
    # Objets & documents & couleurs
    "document": "document", "documents": "documents", "facture": "invoice", "papier": "paper",
    "texte": "text", "ecran": "screen", "telephone": "phone", "ordinateur": "computer",
    "lunettes": "glasses", "chapeau": "hat", "robe": "dress", "vetement": "clothing", "vetements": "clothes",
    "chaussures": "shoes", "sac": "bag", "montre": "watch", "bijou": "jewelry",
    "noir": "black", "noire": "black", "blanc": "white", "blanche": "white",
    "rouge": "red", "bleu": "blue", "bleue": "blue", "vert": "green", "verte": "green",
    "jaune": "yellow", "orange": "orange", "rose": "pink", "violet": "purple", "gris": "gray",
}

_KNOWN_EN_HINT_WORDS = set(_FR_EN_WORDS.values()) | {
    "a", "an", "the", "of", "with", "in", "on", "at", "by", "and", "or",
    "photo", "picture", "image", "shot", "closeup", "outdoor", "indoor",
    "sunrise", "sunset", "screenshot", "selfie", "party", "travel", "food",
}


def _strip_accents(s: str) -> str:
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def _offline_translate_fr_en(text: str) -> tuple[str, bool]:
    """Traduit via le lexique local. Retourne (texte_en, tous_mots_connus)."""
    norm = _strip_accents(text.lower()).replace("'", " ").replace("-", " ")
    for fr_p, en_p in _FR_PHRASES:
        if fr_p in norm:
            norm = norm.replace(fr_p, f" __EN_{en_p.replace(' ', '_')}__ ")

    tokens = re.findall(r"[a-z0-9_]+", norm)
    out_words: list[str] = []
    all_known = True
    for tok in tokens:
        if tok.startswith("__EN_") and tok.endswith("__"):
            out_words.append(tok[5:-2].replace("_", " "))
        elif tok in _FR_STOPWORDS:
            continue
        elif tok in _FR_EN_WORDS:
            out_words.append(_FR_EN_WORDS[tok])
        elif tok in _KNOWN_EN_HINT_WORDS or tok.isdigit():
            out_words.append(tok)
        else:
            all_known = False
            out_words.append(tok)

    if not out_words:
        return text.strip(), False
    return " ".join(out_words), all_known


def _online_translate_fr_en(text: str, timeout: float = 1.5) -> str | None:
    global _OFFLINE_UNTIL
    now = time.monotonic()
    if now < _OFFLINE_UNTIL:
        return None
    q = urllib.parse.quote(text)
    url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=fr&tl=en&dt=t&q={q}"
    req = urllib.request.Request(url, headers={"User-Agent": "Phototo/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        parts = [seg[0] for seg in (data[0] or []) if seg and seg[0]]
        translated = "".join(parts).strip()
        return translated or None
    except Exception:
        _OFFLINE_UNTIL = now + 30.0
        return None


def translate_fr_to_en(text: str, allow_online: bool = True) -> str:
    """
    Traduit silencieusement un libellé/prompt français en anglais pour les modèles CLIP EN (vit-l-14 / vit-b-16).
    Utilise un lexique local instantané, et complète en ligne avec cache si des mots sont inconnus.
    """
    raw = (text or "").strip()
    if not raw:
        return ""
    cached = _FR_EN_CACHE.get(raw)
    if cached is not None:
        return cached

    offline_en, all_known = _offline_translate_fr_en(raw)
    result = offline_en
    if not all_known and allow_online:
        online = _online_translate_fr_en(raw)
        if online:
            result = online

    _FR_EN_CACHE[raw] = result
    return result
