#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Dark Souls III (PC) save reader for DS30000.sl2.

Container / crypto (format from tremwil/DS3SaveUnpacker, MIT; verified on a real save):
  BND4 header 0x40:
    0x00 u32 magic 'BND4'      0x0C u32 fileCount
    0x20 u64 entryHeaderSize   0x28 u64 dataOffset     0x30 u8 isUnicode
  Entry header 0x20 (at 0x40 + i*0x20):
    0x00 u64 padding (0xFFFFFFFF00000050)   0x08 u64 size
    0x10 u32 dataOffset                     0x14 u32 nameOffset
  Entry data: [0:16]=MD5(data[16:])  [16:32]=IV  [32:]=AES-128-CBC/PKCS7

WHY THIS FILE DOES NOT USE FIXED OFFSETS
  The character block MOVES between saves: the same character's name sat at
  0x14148 in one save and at 0x13928 in the next, a 0x820 shift caused by a
  variable-length region earlier in the slot. Hardcoded offsets silently
  produce garbage once the game rewrites the file. We therefore scan for the
  name and validate the surrounding structure before trusting it.

Character block, all offsets RELATIVE to the name field:
  name-0x44  8 x u32  VIG ATN END STR DEX INT FTH LCK
  name-0x1C  u32      VIT          (stored apart from the run above)
  name-0x18  u32      level
  name-0x14  u32      souls held
  name       16 x UTF-16LE, null padded

Usage:
    python dump_save.py [--json] [save ...]
"""
import glob
import hashlib
import json
import os
import re
import struct
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AES_KEY = bytes.fromhex("FD464D695E69A39A10E319A7ACE8B7FA")
SLOT_COUNT = 10                 # USER_DATA000..009 are character slots

NAME_LEN = 16
STATS_OFF = -0x44               # relative to name
VIT_OFF = -0x1C
LEVEL_OFF = -0x18
SOULS_OFF = -0x14
STAT_ORDER = ("VIG", "ATN", "END", "STR", "DEX", "INT", "FTH", "LCK")


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def u64(b, o):
    return struct.unpack_from("<Q", b, o)[0]


def find_save():
    pat = os.path.expandvars(r"%APPDATA%\DarkSoulsIII\*\DS30000.sl2")
    hits = sorted(glob.glob(pat), key=os.path.getmtime, reverse=True)
    return hits[0] if hits else None


def decrypt_entry(blob):
    d = Cipher(algorithms.AES(AES_KEY), modes.CBC(blob[16:32])).decryptor()
    out = d.update(blob[32:]) + d.finalize()
    pad = out[-1]
    if 0 < pad <= 16 and out[-pad:] == bytes([pad]) * pad:
        out = out[:-pad]
    # The slot payload starts with a u32 length prefix (payload length - 4).
    # Stripping it puts every downstream offset in "payload space".
    if len(out) >= 4 and u32(out, 0) == len(out) - 4:
        out = out[4:]
    return out


def read_entries(raw):
    """Yield (index, name, plaintext, md5_ok) for every BND4 entry."""
    if raw[:4] != b"BND4":
        raise ValueError("not a BND4 container")
    count = u32(raw, 0x0C)
    ehs = u64(raw, 0x20)
    unicode_names = raw[0x30] == 1
    for i in range(count):
        o = 0x40 + i * ehs
        size = u64(raw, o + 0x08)
        doff = u32(raw, o + 0x10)
        noff = u32(raw, o + 0x14)
        if unicode_names:
            end = noff
            while end + 1 < len(raw) and raw[end:end + 2] != b"\x00\x00":
                end += 2
            name = raw[noff:end].decode("utf-16-le", "replace")
        else:
            end = raw.index(b"\x00", noff)
            name = raw[noff:end].decode("ascii", "replace")
        blob = raw[doff:doff + size]
        md5_ok = hashlib.md5(blob[16:]).digest() == blob[0:16]
        try:
            plain = decrypt_entry(blob)
        except Exception:  # noqa: BLE001
            plain = b""
        yield i, name, plain, md5_ok


def _plausible_name(text):
    if not 1 <= len(text) <= NAME_LEN:
        return False
    for ch in text:
        cp = ord(ch)
        if 0x20 <= cp <= 0x7E:
            continue
        if 0x4E00 <= cp <= 0x9FFF or 0x3040 <= cp <= 0x30FF:
            continue
        return False
    return True


def _validate_character(p, name_off):
    """Structure that must hold around a candidate name offset."""
    base = name_off + STATS_OFF
    if base < 0 or name_off + 2 * NAME_LEN > len(p):
        return None
    stats = [u32(p, base + 4 * k) for k in range(8)]
    if not all(1 <= v <= 99 for v in stats):
        return None
    vit = u32(p, name_off + VIT_OFF)
    level = u32(p, name_off + LEVEL_OFF)
    souls = u32(p, name_off + SOULS_OFF)
    if not (1 <= vit <= 99):
        return None
    if not (1 <= level <= 802):
        return None
    if level > sum(stats) + vit:
        return None
    return stats, vit, level, souls


# A UTF-16LE ASCII string is runs of (byte, 0). Scanning 786k offsets one at a
# time cost 4.2 s, which dominated every call; the regex prefilter finds the same
# candidates in ~17 ms.
_ASCII_RUN = re.compile(rb"(?:[\x20-\x7e]\x00)+")


def find_character(p):
    """Locate the character block by validating structure, not by fixed offset."""
    n = len(p) - 2 * NAME_LEN
    # An unused slot is zero-filled. Without this the slow path below scans
    # 786k offsets and costs 0.32 s per empty slot — nine of them per save.
    if not p.strip(b"\x00"):
        return None
    # fast path: ASCII UTF-16 names have a zero high byte
    for match in _ASCII_RUN.finditer(p, 0, n + 2 * NAME_LEN):
        # A run may start mid-name; the stats/level/souls validation rejects
        # every offset except the real name field.
        for off in range(match.start(), min(match.end(), n + 2), 2):
            try:
                text = p[off:off + 2 * NAME_LEN].decode("utf-16-le").split("\x00")[0]
            except UnicodeDecodeError:
                continue
            if not _plausible_name(text):
                continue
            v = _validate_character(p, off)
            if v:
                return build(text, off, v)
    # slow path: non-ASCII names
    for off in range(2, n, 2):
        try:
            text = p[off:off + 2 * NAME_LEN].decode("utf-16-le").split("\x00")[0]
        except UnicodeDecodeError:
            continue
        if not _plausible_name(text):
            continue
        v = _validate_character(p, off)
        if v:
            return build(text, off, v)
    return None


def build(text, name_off, validated):
    stats, vit, level, souls = validated
    s = dict(zip(STAT_ORDER, stats))
    s["VIT"] = vit
    return {"name": text, "level": level, "souls": souls, "stats": s, "nameOffset": name_off}


# ---------------------------------------------------------------------------
# Event flags
#
# The mechanism was derived by reading mozartdiniz/ds3-advisor, which publishes
# no licence; the implementation below is written independently and only relies
# on facts about the format (offsets, flag-ID encoding). The slot payload is a
# sequential serialisation: gaitem item registry (variable size), inventory,
# storage box, gestures, then a fixed-size event-flag section that holds a copy
# of the game's in-memory world-flag blob.
# ---------------------------------------------------------------------------

GAITEM_START = 0x6C
GAITEM_SLOTS = 6144
GAITEM_EXTRA = 52                  # weapon/armour entries are 60 bytes, not 8
ITEM_TYPES = (0x80000000, 0x90000000)

FLAG_SECTION_SIZE = 0x33E5E
BLOB_DELTA = 0x5D
BLOCK_BYTES = 0x500
COMMONS_MAX = 30720
REGION_ORIGIN = {1: 0x00F00, 6: 0x1FE00, 7: 0x2A300}   # event / object / talk

MAP_SLOT = {
    3000: 0, 3010: 1, 3100: 2, 3200: 4, 3300: 6, 3410: 8, 3500: 9,
    3700: 12, 3800: 13, 3900: 14, 4000: 15, 4100: 16,
    4500: 17, 5000: 20, 5100: 21, 5110: 22,
}


def flag_blob_offset(payload):
    """Absolute offset of the world-flag blob, or None if the walk fails."""
    try:
        off = GAITEM_START
        for _ in range(GAITEM_SLOTS):
            handle = u32(payload, off)
            off += 8
            if handle and (handle & 0xF0000000) in ITEM_TYPES:
                off += GAITEM_EXTRA
        inventory = off + 0x13F + 0x1DD
        counter = inventory + 0x8808 + 0x11C
        count1 = u32(payload, counter)
        table1_end = counter + 4 + count1 * 8
        box = table1_end + 0x18C + 4
        gestures = box + 0x8800 + 0xC + 0xA4
        count2 = u32(payload, gestures)
        table2_end = gestures + 4 + count2 * 4
        blob = table2_end + 0x92 + 0xBCC + BLOB_DELTA
    except struct.error:
        return None
    return blob if blob + FLAG_SECTION_SIZE <= len(payload) else None


def flag_offset(flag_id):
    """Semantic flag ID -> (byte offset in blob, bit), or None."""
    if 0 <= flag_id < COMMONS_MAX:
        return (flag_id // 32) * 4 + 3 - ((flag_id % 32) // 8), 7 - flag_id % 8
    system = flag_id // 10_000_000
    origin = REGION_ORIGIN.get(system)
    if origin is None:
        return None
    rest = flag_id - system * 10_000_000
    for code in (rest // 1000, rest // 10000 * 10):
        slot = MAP_SLOT.get(code)
        if slot is None:
            continue
        local = rest - code * 1000
        if 0 <= local < BLOCK_BYTES * 8:
            return (origin + slot * BLOCK_BYTES
                    + (local // 32) * 4 + 3 - ((local % 32) // 8)), 7 - local % 8
    return None


def read_flag(payload, blob, flag_id):
    loc = flag_offset(flag_id)
    if loc is None:
        return None
    byte, bit = loc
    pos = blob + byte
    if pos >= len(payload):
        return None
    return (payload[pos] >> bit) & 1


# ---------------------------------------------------------------------------
# Flag diffing — the calibration tool.
#
# Two saves of the same character bracket a play session; the bits that
# changed are exactly the events triggered in that session. That is how the
# flag dictionary gets built without guessing.
# ---------------------------------------------------------------------------

_SLOT_TO_MAP = {v: k for k, v in MAP_SLOT.items()}
_BLOCK_SPAN = (max(MAP_SLOT.values()) + 1) * BLOCK_BYTES


def flag_id_from_offset(rel, bit):
    """Inverse of flag_offset: blob-relative (byte, bit) -> semantic flag ID."""
    if rel < 0:
        return None
    if rel < 0xF00:
        word, biw = rel // 4, rel % 4
        return word * 32 + (3 - biw) * 8 + (7 - bit)
    for system, origin in REGION_ORIGIN.items():
        if origin <= rel < origin + _BLOCK_SPAN:
            slot = (rel - origin) // BLOCK_BYTES
            code = _SLOT_TO_MAP.get(slot)
            if code is None:
                return None
            within = rel - origin - slot * BLOCK_BYTES
            word, biw = within // 4, within % 4
            local = word * 32 + (3 - biw) * 8 + (7 - bit)
            return system * 10_000_000 + code * 1000 + local
    return None


def label_for_flag(flag_id):
    """Human label for a flag, if any table covers it."""
    if flag_id in BOSS_FLAGS:
        return BOSS_FLAGS[flag_id]
    table = bonfire_table()
    if flag_id in table:
        return table[flag_id]
    learned = learned_flags()
    entry = learned.get(str(flag_id))
    if entry:
        return entry.get("label")
    return None


def diff_flags(payload_a, payload_b):
    """Compare the event-flag blobs of two slot payloads.

    Returns (set, cleared, unknown) where entries are
    {"flag": int|None, "bit": "0x..b..", "label": str|None}.
    """
    blob_a = flag_blob_offset(payload_a)
    blob_b = flag_blob_offset(payload_b)
    if blob_a is None or blob_b is None:
        raise ValueError("could not locate the event-flag section in one of the saves")

    span = FLAG_SECTION_SIZE - BLOB_DELTA
    limit = min(span, len(payload_a) - blob_a, len(payload_b) - blob_b)
    set_flags, cleared, unknown = [], [], []

    for rel in range(limit):
        x = payload_a[blob_a + rel]
        y = payload_b[blob_b + rel]
        if x == y:
            continue
        diff = x ^ y
        for bit in range(8):
            if not (diff >> bit) & 1:
                continue
            fid = flag_id_from_offset(rel, bit)
            entry = {
                "flag": fid,
                "bit": "rel0x%X b%d" % (rel, bit),
                "label": label_for_flag(fid) if fid else None,
            }
            if fid is None:
                unknown.append(entry)
            elif (y >> bit) & 1:
                set_flags.append(entry)
            else:
                cleared.append(entry)
    return set_flags, cleared, unknown


_LEARNED_FLAGS = None


def learned_flags():
    """Diff-calibrated flags from data/reference/ds3/flags.json (id -> entry)."""
    global _LEARNED_FLAGS
    if _LEARNED_FLAGS is None:
        try:
            with open(os.path.join(ROOT, "data", "reference", "ds3", "flags.json"), encoding="utf-8") as fh:
                _LEARNED_FLAGS = json.load(fh).get("flags", {})
        except (OSError, ValueError):
            _LEARNED_FLAGS = {}
    return _LEARNED_FLAGS


def flag_area_local(flag_id):
    """(area code, local index) for a semantic flag ID, or (None, None)."""
    if flag_id < COMMONS_MAX:
        return None, flag_id
    system = flag_id // 10_000_000
    if system not in REGION_ORIGIN:
        return None, None
    rest = flag_id - system * 10_000_000
    for code in sorted(MAP_SLOT, key=lambda c: -c):
        local = rest - code * 1000
        if 0 <= local < BLOCK_BYTES * 8:
            return code, local
    return None, None


# Real progress flags (bosses, bonfires, quest beats) live at a low local
# index. Area-load bookkeeping uses high local indices (4xxx-5xxx) and flips
# every time the player changes map, which would otherwise swamp a diff.
PROGRESS_LOCAL_MAX = 1000


def is_progress_flag(flag_id):
    _code, local = flag_area_local(flag_id)
    return local is not None and local < PROGRESS_LOCAL_MAX


# Covenant turn-in items. Counting these is what lets the guide say "you need 8
# more Sunlight Medals for rank 1" instead of "grind covenants".
COVENANT_TOKENS = frozenset({
    "Proof of a Concord Kept",
    "Vertebra Shackle",
    "Sunlight Medal",
    "Pale Tongue",
    "Human Dregs",
    "Wolf's Blood Swordgrass",
    "Forked Pale Tongue",
    "Proof of a Concord Well Kept",
})
BOSS_FLAGS = {
    14000800: "灰烬审判者古达",    13000800: "冷冽谷的波尔多", 13100800: "诅咒树妖",
    13300800: "深渊监视者", 13300850: "结晶长老", 13500800: "深邃主教群",
    13800800: "霸王沃尼尔", 13800830: "老恶魔王", 13700850: "教宗沙力万",
    13700800: "吞噬神明的艾尔德利奇", 13900800: "巨人尤姆", 13000890: "冷冽谷的舞娘",
    13000830: "祭祀场主教奥斯罗艾斯", 13010800: "猎龙铠甲", 13410830: "双子王子",
    13200850: "无名之王", 14000830: "英雄古达", 14100800: "薪王们的化身",
    14500800: "修女芙莉德", 14500860: "守墓人", 15000800: "恶魔王子",
    15100800: "教堂之枪", 15100850: "吞噬黑暗的米狄尔", 15110800: "奴隶骑士盖尔",
}

# ---------------------------------------------------------------------------
# Load-screen summary (entry 10) — playtime and current area
# ---------------------------------------------------------------------------

OCCUPANCY_OFF = 4244
RECORD_OFF = 4254
RECORD_STRIDE = 554
REC_NAME = 0
REC_LEVEL = 34
REC_PLAYTIME = 38
REC_BONFIRE = 50

BONFIRE_AREAS = {
    3000: "洛斯里克高墙", 3010: "洛斯里克城", 3100: "不死聚落", 3200: "古龙顶端",
    3300: "牺牲之路 / 法兰要塞", 3410: "大书库", 3500: "深邃教堂",
    3700: "伊鲁席尔 / 亚诺尔隆德", 3800: "卡萨斯地下墓地 / 烟熏湖",
    3900: "伊鲁席尔地下监狱 / 罪业之都", 4000: "灰烬墓地",
    4005: "传火祭祀场", 4100: "初始之火的火炉", 4500: "艾雷德尔绘画世界",
    5000: "聚集地", 5100: "环印城", 5110: "菲莲诺尔寝室",
    # Observed as the last-rested ID while standing in Smouldering Lake; the
    # load-screen enum uses finer codes than the flag map's area codes.
    3805: "烟熏湖",
    3705: "伊鲁席尔",
    3905: "伊鲁席尔地下监狱 / 罪业之都",
    4006: "灰烬墓地",
}

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
BONFIRE_DB = os.path.join(ROOT, "data", "reference", "ds3", "bonfires.json")

_BONFIRES = None


def bonfire_table():
    """flag_id -> label, from data/reference/ds3/bonfires.json.

    Entries listed under `_pseudo` are placeholder flags that do not correspond
    to a restable bonfire (initial-warp markers, duplicated IDs) and are skipped.
    """
    global _BONFIRES
    if _BONFIRES is None:
        try:
            with open(BONFIRE_DB, encoding="utf-8") as fh:
                doc = json.load(fh)
            pseudo = {int(k) for k in doc.get("_pseudo", {})}
            _BONFIRES = {
                int(k): v for k, v in doc["bonfires"].items() if int(k) not in pseudo
            }
        except (OSError, KeyError, ValueError):
            _BONFIRES = {}
    return _BONFIRES


# ---------------------------------------------------------------------------
# Equipment — offsets are relative to the character-name anchor, which is the
# one positional fact that stays stable when the slot is rewritten.
# Offsets derived from mozartdiniz/ds3-advisor; implementation independent.
# ---------------------------------------------------------------------------

EQUIP_SLOTS = (
    (492, "left_hand", "weapon"),
    (496, "right_hand", "weapon"),
    (540, "head", "armor"),
    (544, "chest", "armor"),
    (548, "hands", "armor"),
    (552, "legs", "armor"),
    (556, "ring_1", "ring"),
    (560, "ring_2", "ring"),
    (564, "ring_3", "ring"),
    (568, "ring_4", "ring"),
)
EMPTY_SLOT = frozenset({0xFFFFFFFF, 0x00000000, 0x0001ADB0})
ITEMS_DB = os.path.join(ROOT, "data", "reference", "ds3", "items.json")
_ITEMS = None


def item_tables():
    """category -> {item id -> name}, from data/reference/ds3/items.json."""
    global _ITEMS
    if _ITEMS is None:
        try:
            with open(ITEMS_DB, encoding="utf-8") as fh:
                doc = json.load(fh)
            _ITEMS = {
                cat: {int(k): v for k, v in doc.get(cat, {}).items()}
                for cat in ("weapon", "armor", "ring", "good")
            }
        except (OSError, ValueError, KeyError):
            _ITEMS = {"weapon": {}, "armor": {}, "ring": {}, "good": {}}
    return _ITEMS


def parse_equipment(payload, name_off):
    """slot -> {id, name} or None, for the equipped loadout."""
    maps = item_tables()
    weapons, armor, rings = maps["weapon"], maps["armor"], maps["ring"]
    armor_by_lower = {i & 0x00FFFFFF: n for i, n in armor.items()}
    out = {}
    for delta, slot, kind in EQUIP_SLOTS:
        pos = name_off + delta
        if pos + 4 > len(payload):
            out[slot] = None
            continue
        val = u32(payload, pos)
        if val in EMPTY_SLOT:
            out[slot] = None
            continue
        name = None
        if kind == "weapon":
            for level in range(0, 11):          # normal +0..+10
                base = val - level
                if base in weapons:
                    name = weapons[base] + (" +%d" % level if level else "")
                    break
        elif kind == "armor":
            name = armor_by_lower.get(val & 0x00FFFFFF)
        else:
            for tier in range(0, 4):            # base + up to +3
                if val < tier:
                    continue
                full = (val - tier) | 0x20000000
                if full in rings:
                    name = rings[full] + (" +%d" % tier if tier else "")
                    break
        out[slot] = {"id": val, "name": name}
    return out


# ---------------------------------------------------------------------------
# Inventory — two 16-byte grids anchored to the character name.
#   0x3E4   regular items (weapons, armour, rings, goods)
#   0x7AA8  key items (keys, ashes, quest items)
# Record: +0 handle, +4 item id, +8 count, +12 instance.
# The grid contains short sentinel gaps between sub-sections; a long run marks
# the real end, so we tolerate short gaps and stop only after a long one.
# ---------------------------------------------------------------------------

INV_OFFSET_FROM_NAME = 0x3E4
KEY_ITEMS_OFFSET_FROM_NAME = 0x7AA8
INV_RECORD = 16
INV_ID = 4
INV_COUNT = 8
INV_SENTINELS = frozenset({0x00000000, 0xFFFFFFFF})
INV_MAX_GAP = 64


def classify_item(item_id):
    """Category from the item ID's high byte, or None for sentinels/unknown."""
    if item_id in INV_SENTINELS:
        return None
    high = (item_id >> 24) & 0xFF
    if high == 0x00:
        return "weapon"
    if 0x10 <= high <= 0x1F:
        return "armor"
    if high == 0x20:
        return "ring"
    if high == 0x40:
        return "good"
    return None


def scan_grid(payload, start, maps):
    items = []
    off = start
    gap = 0
    limit = len(payload) - INV_RECORD
    while off <= limit and gap < INV_MAX_GAP:
        item_id = u32(payload, off + INV_ID)
        category = classify_item(item_id)
        if category is None:
            gap += 1
            off += INV_RECORD
            continue
        items.append({
            "category": category,
            "id": item_id,
            "count": u32(payload, off + INV_COUNT),
            "name": maps.get(category, {}).get(item_id),
        })
        gap = 0
        off += INV_RECORD
    return items


def parse_inventory(payload, name_off):
    maps = item_tables()
    return {
        "regular": scan_grid(payload, name_off + INV_OFFSET_FROM_NAME, maps),
        "key": scan_grid(payload, name_off + KEY_ITEMS_OFFSET_FROM_NAME, maps),
    }


def parse_userdata(payload):
    out = {}
    if len(payload) < RECORD_OFF + 10 * RECORD_STRIDE:
        return out
    for i in range(10):
        if not (payload[OCCUPANCY_OFF + i] & 1):
            continue
        off = RECORD_OFF + i * RECORD_STRIDE
        playtime = u32(payload, off + REC_PLAYTIME)
        bonfire = struct.unpack_from("<H", payload, off + REC_BONFIRE)[0]
        out[i] = {
            "level": u32(payload, off + REC_LEVEL),
            "playtime": playtime,
            "bonfire": bonfire,
            "area": BONFIRE_AREAS.get(bonfire),
        }
    return out


def load(path):
    raw = open(path, "rb").read()
    entries = list(read_entries(raw))
    # The load-screen summary lives in entry 10, which is read after the
    # character slots — parse it first so each slot can pick up its metadata.
    summary = {}
    for _i, _name, _plain, _md5 in entries:
        if _name == "USER_DATA010":
            summary = parse_userdata(_plain)
            break
    chars = []
    for i, name, plain, md5_ok in entries:
        if name == "USER_DATA010":
            continue
        if i >= SLOT_COUNT or not name.startswith("USER_DATA"):
            continue
        if not md5_ok:
            print("warning: md5 mismatch on %s" % name, file=sys.stderr)
        c = find_character(plain)
        if not c:
            continue
        c["slot"] = i
        c["equipment"] = parse_equipment(plain, c["nameOffset"])
        c["inventory"] = parse_inventory(plain, c["nameOffset"])
        meta = summary.get(i)
        if meta:
            c["level"] = meta["level"] or c["level"]
            c["playtime"] = meta["playtime"]
            c["area"] = meta["area"]
            c["bonfire"] = meta["bonfire"]
        blob = flag_blob_offset(plain)
        c["bosses"] = None
        c["bonfires"] = None
        if blob is not None:
            c["bosses"] = {
                fid: read_flag(plain, blob, fid) for fid in BOSS_FLAGS
            }
            table = bonfire_table()
            if table:
                lit, unlit = [], []
                for fid, label in table.items():
                    v = read_flag(plain, blob, fid)
                    if v == 1:
                        lit.append(label)
                    elif v == 0:
                        unlit.append(label)
                c["bonfires"] = {"lit": lit, "unlit": unlit}
        chars.append(c)
    return chars


def sections_for(c):
    sec = {
        "character": {
            "description": "等级、九项属性、持有灵魂",
            "data": {"level": c["level"], "souls": c["souls"], "stats": c["stats"]},
        }
    }
    if c.get("playtime") is not None:
        sec["progress"] = {
            "description": "游戏时长与最后一次休息的地点",
            "data": {
                "playtimeSeconds": c["playtime"],
                "playtimeHours": round(c["playtime"] / 3600, 1),
                "lastBonfireId": c.get("bonfire"),
                "area": c.get("area"),
            },
        }
    bosses = c.get("bosses")
    if bosses:
        killed = [BOSS_FLAGS[f] for f, v in bosses.items() if v == 1]
        alive = [BOSS_FLAGS[f] for f, v in bosses.items() if v == 0]
        sec["bosses"] = {
            "description": "Boss 击败状态（由事件旗标解码；只覆盖已收录的 Boss）",
            "data": {
                "killed": killed,
                "alive": alive,
                "killedCount": len(killed),
                "aliveCount": len(alive),
            },
        }
    inv = c.get("inventory")
    if inv:
        regular, key = inv["regular"], inv["key"]
        counts = {}
        for item in regular:
            counts[item["category"]] = counts.get(item["category"], 0) + 1
        stacks = sorted(
            (i for i in regular if i["count"] > 1), key=lambda i: -i["count"]
        )[:15]
        sec["inventory"] = {
            "description": "背包概览：各类物品数量、关键道具（钥匙/卷轴/任务物品）、可堆叠物品前 15、已持有物品 ID 全集、Boss 灵魂、誓约道具",
            "data": {
                "counts": counts,
                "keyItems": [i["name"] or ("未知 0x%08X" % i["id"]) for i in key],
                "topStacks": [
                    {"name": i["name"] or ("未知 0x%08X" % i["id"]), "count": i["count"]}
                    for i in stacks
                ],
                "unnamedCount": sum(1 for i in regular if not i["name"]),
                # The only evidence that a ring/spell was ever obtained: the game
                # keeps no collection checklist, so presence in the bag is it.
                # Sorted for a stable diff; no names, so the list stays small.
                "ownedIds": sorted({i["id"] for i in regular + key}),
                # Boss souls still in the bag mean the boss is dead and its soul
                # is unspent: one item is available right now at the kiln. This
                # is the most directly actionable fact the save can prove.
                "bossSouls": sorted(
                    i["name"] for i in regular
                    if i["name"] and i["name"].startswith("Soul of")
                ),
                # Covenant turn-in progress, so rank requirements are computable.
                "covenantTokens": {
                    i["name"]: i["count"] for i in regular + key
                    if i["name"] in COVENANT_TOKENS
                },
            },
        }
    eq = c.get("equipment")
    if eq:
        slots = {}
        for slot, value in eq.items():
            if not value:
                slots[slot] = None
            else:
                slots[slot] = value["name"] or ("未知物品 0x%08X" % value["id"])
        sec["equipment"] = {
            "description": "当前装备的武器、防具与戒指（名称为游戏内英文名）",
            "data": slots,
        }
    bf = c.get("bonfires")
    if bf:
        areas = {}
        for label in bf["lit"] + bf["unlit"]:
            areas.setdefault(label.split(" - ")[0], {"lit": 0, "total": 0})
            areas[label.split(" - ")[0]]["total"] += 1
        for label in bf["lit"]:
            areas[label.split(" - ")[0]]["lit"] += 1
        sec["bonfires"] = {
            "description": "已点亮 / 未点亮的篝火，按区域统计。未点亮通常意味着没到过该区域或漏了一个",
            "data": {
                "litCount": len(bf["lit"]),
                "total": len(bf["lit"]) + len(bf["unlit"]),
                "unlit": sorted(bf["unlit"]),
                "byArea": [
                    {"area": k, "lit": v["lit"], "total": v["total"]}
                    for k, v in sorted(areas.items())
                ],
            },
        }
    return sec


def slot_payload(path):
    """Decrypted payload of character slot 0."""
    raw = open(path, "rb").read()
    for i, _name, plain, _md5 in read_entries(raw):
        if i == 0:
            return plain
    raise ValueError("slot 0 not found in %s" % path)


def run_diff(path_a, path_b, as_json, only_progress=True):
    set_flags, cleared, unknown = diff_flags(slot_payload(path_a), slot_payload(path_b))
    if only_progress:
        set_flags = [e for e in set_flags if e["flag"] and is_progress_flag(e["flag"])]
        cleared = [e for e in cleared if e["flag"] and is_progress_flag(e["flag"])]
    if as_json:
        print(json.dumps({
            "save_a": path_a,
            "save_b": path_b,
            "set": set_flags,
            "cleared": cleared,
            "unknown": unknown,
        }, ensure_ascii=False, indent=2))
        return 0

    def show(title, items):
        print("%s（%d）" % (title, len(items)))
        for e in items:
            who = e["label"] or ("旗标 %d" % e["flag"] if e["flag"] else "未解码")
            print("   %-46s %s" % (who, e["bit"]))
        if not items:
            print("   （无）")

    print("A:", path_a)
    print("B:", path_b)
    print("-" * 74)
    show("新置位（这段进度触发了什么）", set_flags)
    show("被清除", cleared)
    if unknown:
        show("无法映射到语义 ID 的位（多半在未收录的地图块里）", unknown[:10])
        if len(unknown) > 10:
            print("   ……另有 %d 条，加 --all 查看完整列表" % (len(unknown) - 10))
    return 0


def main(argv):
    as_json = "--json" in argv
    args = [a for a in argv if not a.startswith("--")]
    paths = args or [p for p in (find_save(),) if p]
    if not paths:
        print("no DS3 save found", file=sys.stderr)
        return 1

    if "--diff" in argv:
        if len(paths) < 2:
            print("--diff 需要两个存档路径", file=sys.stderr)
            return 2
        return run_diff(paths[0], paths[1], as_json, only_progress="--all" not in argv)

    parsed = []
    for path in paths:
        for c in load(path):
            c["save"] = path
            parsed.append(c)

    if as_json:
        out = []
        for c in parsed:
            out.append({
                "identity": {
                    "saveName": c["name"],
                    "gameId": "ds3",
                    "slot": c["slot"],
                    "extra": {"level": c["level"], "area": c.get("area")},
                },
                "summary": "%s，Lv%d，持有 %d 魂%s" % (
                    c["name"], c["level"], c["souls"],
                    "，" + c["area"] if c.get("area") else ""),
                "source": {"save": c["save"]},
                "sections": sections_for(c),
            })
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    for path in paths:
        print("=" * 74)
        print("FILE :", path)
        print("mtime:", __import__("datetime").datetime.fromtimestamp(os.path.getmtime(path)))
    if not parsed:
        print("(no characters)")
        return 0
    for c in parsed:
        s = c["stats"]
        print("-" * 74)
        print("槽 %d  %r  Lv %d  souls %d   (name @ +0x%X)"
              % (c["slot"], c["name"], c["level"], c["souls"], c["nameOffset"]))
        print("  VIG %-3d ATN %-3d END %-3d VIT %-3d"
              % (s["VIG"], s["ATN"], s["END"], s["VIT"]))
        print("  STR %-3d DEX %-3d INT %-3d FTH %-3d LCK %-3d"
              % (s["STR"], s["DEX"], s["INT"], s["FTH"], s["LCK"]))
        if c.get("playtime") is not None:
            print("  时长 %.1f 小时   最后休息：%s"
                  % (c["playtime"] / 3600, c.get("area") or "未知"))
        bosses = c.get("bosses")
        if bosses:
            killed = [BOSS_FLAGS[f] for f, v in bosses.items() if v == 1]
            alive = [BOSS_FLAGS[f] for f, v in bosses.items() if v == 0]
            print("  Boss 已击败 %d：%s" % (len(killed), "、".join(killed) or "无"))
            print("  Boss 未击败 %d：%s" % (len(alive), "、".join(alive) or "无"))
        else:
            print("  Boss：旗标段未定位")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
