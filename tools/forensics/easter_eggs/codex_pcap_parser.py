import binascii
import collections
import glob
import json
import math
import os
import re
import struct
from datetime import datetime, timezone


FILES = sorted(glob.glob("sensor*.pcap"))


def mac(b):
    return ":".join(f"{x:02x}" for x in b)


def printable(bs):
    return "".join(chr(x) if 32 <= x <= 126 else "." for x in bs)


def is_printable(bs, min_ratio=0.85):
    if not bs:
        return False
    return sum(32 <= x <= 126 for x in bs) / len(bs) >= min_ratio


def hexdump(bs, limit=128):
    s = binascii.hexlify(bs[:limit]).decode()
    if len(bs) > limit:
        s += "..."
    return s


class PcapReader:
    def __init__(self, fn):
        self.fn = fn
        self.f = open(fn, "rb")
        gh = self.f.read(24)
        if len(gh) != 24:
            raise ValueError("short global header")
        magic = gh[:4]
        if magic == b"\xd4\xc3\xb2\xa1":
            self.endian = "<"
            self.ns = False
        elif magic == b"\xa1\xb2\xc3\xd4":
            self.endian = ">"
            self.ns = False
        elif magic == b"\x4d\x3c\xb2\xa1":
            self.endian = "<"
            self.ns = True
        elif magic == b"\xa1\xb2\x3c\x4d":
            self.endian = ">"
            self.ns = True
        else:
            raise ValueError(f"bad magic {magic.hex()}")
        self.global_header = gh
        self.version_major, self.version_minor, self.thiszone, self.sigfigs, self.snaplen, self.network = struct.unpack(
            self.endian + "HHiiii", gh[4:24]
        )

    def __iter__(self):
        frame_no = 0
        while True:
            off = self.f.tell()
            rh = self.f.read(16)
            if not rh:
                return
            if len(rh) != 16:
                return
            ts_sec, ts_frac, incl, orig = struct.unpack(self.endian + "IIII", rh)
            data = self.f.read(incl)
            if len(data) != incl:
                return
            frame_no += 1
            yield {
                "fn": self.fn,
                "frame": frame_no,
                "pcap_off": off,
                "data_off": off + 16,
                "ts_sec": ts_sec,
                "ts_frac": ts_frac,
                "incl": incl,
                "orig": orig,
                "data": data,
            }


def radiotap_info(data):
    if len(data) < 8:
        return None
    ver, pad, rt_len = struct.unpack_from("<BBH", data, 0)
    if ver != 0 or rt_len < 8 or rt_len > len(data):
        return None
    return {"len": rt_len, "raw": data[:rt_len]}


def parse_ies(buf, base_abs_off):
    ies = []
    i = 0
    while i + 2 <= len(buf):
        eid = buf[i]
        ln = buf[i + 1]
        if i + 2 + ln > len(buf):
            ies.append({"eid": eid, "len": ln, "bad": True, "off": base_abs_off + i, "raw": buf[i:]})
            break
        val = buf[i + 2 : i + 2 + ln]
        ies.append({"eid": eid, "len": ln, "off": base_abs_off + i, "raw": val})
        i += 2 + ln
    if i != len(buf):
        ies.append({"eid": None, "len": len(buf) - i, "bad": True, "off": base_abs_off + i, "raw": buf[i:]})
    return ies


def mgmt_ie_start(subtype, body):
    if subtype in (8, 5):  # beacon, probe response
        return 12 if len(body) >= 12 else None
    if subtype == 4:  # probe request
        return 0
    if subtype == 0:  # assoc request
        return 4 if len(body) >= 4 else None
    if subtype in (1, 3):  # assoc/reassoc response
        return 6 if len(body) >= 6 else None
    if subtype == 2:  # reassoc request
        return 10 if len(body) >= 10 else None
    return None


def frame_type_name(t, st):
    if t == 0:
        names = {
            0: "assoc_req",
            1: "assoc_resp",
            2: "reassoc_req",
            3: "reassoc_resp",
            4: "probe_req",
            5: "probe_resp",
            8: "beacon",
            9: "atim",
            10: "disassoc",
            11: "auth",
            12: "deauth",
            13: "action",
        }
        return names.get(st, f"mgmt_{st}")
    if t == 1:
        return f"ctrl_{st}"
    if t == 2:
        return f"data_{st}"
    return f"ext_{st}"


def parse_80211(rec):
    data = rec["data"]
    rt = radiotap_info(data)
    if not rt:
        return None
    pos = rt["len"]
    if pos + 10 > len(data):
        return None
    fc = struct.unpack_from("<H", data, pos)[0]
    t = (fc >> 2) & 3
    st = (fc >> 4) & 0xF
    flags = (fc >> 8) & 0xFF
    out = {
        "rt_len": rt["len"],
        "mac_off": rec["data_off"] + pos,
        "fc": fc,
        "type": t,
        "subtype": st,
        "kind": frame_type_name(t, st),
        "flags": flags,
        "addr": [],
        "seq": None,
        "body": b"",
        "body_off": None,
        "hdr_len": None,
    }
    if t == 0:
        if pos + 24 > len(data):
            return out
        out["addr"] = [mac(data[pos + 4 : pos + 10]), mac(data[pos + 10 : pos + 16]), mac(data[pos + 16 : pos + 22])]
        seqctl = struct.unpack_from("<H", data, pos + 22)[0]
        out["seq"] = seqctl >> 4
        out["hdr_len"] = 24
        out["body_off"] = rec["data_off"] + pos + 24
        out["body"] = data[pos + 24 :]
    elif t == 2:
        if pos + 24 > len(data):
            return out
        out["addr"] = [mac(data[pos + 4 : pos + 10]), mac(data[pos + 10 : pos + 16]), mac(data[pos + 16 : pos + 22])]
        hdr = 24
        to_ds = flags & 1
        from_ds = flags & 2
        if to_ds and from_ds and pos + hdr + 6 <= len(data):
            out["addr"].append(mac(data[pos + hdr : pos + hdr + 6]))
            hdr += 6
        seqctl = struct.unpack_from("<H", data, pos + 22)[0]
        out["seq"] = seqctl >> 4
        if st & 0x8 and pos + hdr + 2 <= len(data):
            hdr += 2
        out["hdr_len"] = hdr
        out["body_off"] = rec["data_off"] + pos + hdr
        out["body"] = data[pos + hdr :]
    elif t == 1:
        # Extract every MAC-looking control address position conservatively.
        if st in (10, 11):  # PS-Poll, RTS
            addrs = [data[pos + 4 : pos + 10], data[pos + 10 : pos + 16]]
        elif st in (12, 13, 14, 15):  # CTS, ACK, CF-End, CF-End+CF-Ack
            addrs = [data[pos + 4 : pos + 10]]
        else:
            addrs = []
        out["addr"] = [mac(a) for a in addrs if len(a) == 6]
    return out


def llc_eapol(parsed):
    b = parsed["body"]
    if len(b) >= 8 and b[:8] == b"\xaa\xaa\x03\x00\x00\x00\x88\x8e":
        return b[8:], parsed["body_off"] + 8
    return None, None


def summarize():
    res = {
        "pcap": {},
        "frame_counts": collections.Counter(),
        "ies": collections.Counter(),
        "ie_values": collections.Counter(),
        "ie_examples": collections.defaultdict(list),
        "ssid": collections.Counter(),
        "ssid_examples": collections.defaultdict(list),
        "vendor": collections.Counter(),
        "vendor_examples": collections.defaultdict(list),
        "ext": collections.Counter(),
        "ext_examples": collections.defaultdict(list),
        "odd_ie": [],
        "macs": collections.Counter(),
        "mac_examples": collections.defaultdict(list),
        "rare_status_reason": collections.Counter(),
        "status_reason_examples": collections.defaultdict(list),
        "assoc": [],
        "beacon_tsf": [],
        "eap": collections.Counter(),
        "eap_examples": collections.defaultdict(list),
        "eap_identity": collections.Counter(),
        "eap_identity_examples": collections.defaultdict(list),
        "eapol_key": [],
        "deauth": [],
        "action_printable": [],
        "raw_printables": collections.Counter(),
        "raw_printable_examples": collections.defaultdict(list),
    }
    raw_string_re = re.compile(rb"[A-Za-z0-9_.:@/# +\\-]{4,}")
    for fn in FILES:
        pr = PcapReader(fn)
        res["pcap"][fn] = {
            "magic": pr.global_header[:4].hex(),
            "version": [pr.version_major, pr.version_minor],
            "snaplen": pr.snaplen,
            "network": pr.network,
        }
        for rec in pr:
            res["frame_counts"][(fn, "total")] += 1
            data = rec["data"]
            for m in raw_string_re.finditer(data):
                s = m.group().decode("ascii", "replace")
                if len(s) >= 4:
                    res["raw_printables"][s] += 1
                    if len(res["raw_printable_examples"][s]) < 5:
                        res["raw_printable_examples"][s].append([fn, rec["frame"], rec["data_off"] + m.start()])
            p = parse_80211(rec)
            if not p:
                res["frame_counts"][(fn, "bad")] += 1
                continue
            res["frame_counts"][(fn, p["kind"])] += 1
            for a in p["addr"]:
                res["macs"][a] += 1
                if len(res["mac_examples"][a]) < 5:
                    res["mac_examples"][a].append([fn, rec["frame"], p["mac_off"]])
            if p["type"] == 0:
                body = p["body"]
                # fixed-field status/reason/AID/etc
                if p["subtype"] in (1, 3) and len(body) >= 6:
                    cap, status, aid = struct.unpack_from("<HHH", body, 0)
                    key = ("assoc_status", status)
                    res["rare_status_reason"][key] += 1
                    if len(res["status_reason_examples"][key]) < 8:
                        res["status_reason_examples"][key].append([fn, rec["frame"], p["body_off"] + 2, aid, hexdump(body[:6])])
                    res["assoc"].append([fn, rec["frame"], p["addr"], p["seq"], status, aid, p["body_off"], hexdump(body[:6])])
                if p["subtype"] in (10, 12) and len(body) >= 2:
                    reason = struct.unpack_from("<H", body, 0)[0]
                    key = ("reason", reason, p["kind"])
                    res["rare_status_reason"][key] += 1
                    if len(res["status_reason_examples"][key]) < 8:
                        res["status_reason_examples"][key].append([fn, rec["frame"], p["body_off"], hexdump(body[:2]), p["addr"]])
                    if p["subtype"] == 12:
                        res["deauth"].append([fn, rec["frame"], rec["ts_sec"] + rec["ts_frac"] / 1e6, reason, p["addr"], p["seq"], p["body_off"]])
                if p["subtype"] in (8, 5) and len(body) >= 8:
                    tsf = struct.unpack_from("<Q", body, 0)[0]
                    if len(res["beacon_tsf"]) < 10000:
                        res["beacon_tsf"].append([fn, rec["frame"], p["kind"], rec["ts_sec"], rec["ts_frac"], tsf, p["body_off"]])
                ie_start = mgmt_ie_start(p["subtype"], body)
                if ie_start is not None:
                    ies = parse_ies(body[ie_start:], p["body_off"] + ie_start)
                    for ie in ies:
                        eid = ie["eid"]
                        raw = ie["raw"]
                        key = (p["kind"], eid, ie.get("len"))
                        res["ies"][key] += 1
                        valkey = (eid, hexdump(raw, 64))
                        res["ie_values"][valkey] += 1
                        if len(res["ie_examples"][valkey]) < 5:
                            res["ie_examples"][valkey].append([fn, rec["frame"], ie["off"], p["kind"]])
                        if eid == 0:
                            s = raw.decode("latin1", "replace")
                            res["ssid"][s] += 1
                            if len(res["ssid_examples"][s]) < 10:
                                res["ssid_examples"][s].append([fn, rec["frame"], ie["off"], p["kind"], hexdump(raw)])
                        elif eid == 221 and len(raw) >= 3:
                            oui = raw[:3].hex(":")
                            payload = raw[3:]
                            vkey = (oui, hexdump(payload, 96), printable(payload))
                            res["vendor"][vkey] += 1
                            if len(res["vendor_examples"][vkey]) < 10:
                                res["vendor_examples"][vkey].append([fn, rec["frame"], ie["off"], p["kind"], hexdump(raw)])
                        elif eid == 255 and len(raw) >= 1:
                            ekey = (raw[0], hexdump(raw[1:], 96), printable(raw[1:]))
                            res["ext"][ekey] += 1
                            if len(res["ext_examples"][ekey]) < 10:
                                res["ext_examples"][ekey].append([fn, rec["frame"], ie["off"], p["kind"], hexdump(raw)])
                        if eid is not None and (eid > 127 or eid in (7, 48, 54, 55, 70, 74, 107, 127, 191, 192, 221, 255)):
                            if is_printable(raw) and len(raw) >= 4:
                                res["odd_ie"].append([fn, rec["frame"], p["kind"], eid, ie["off"], hexdump(raw), printable(raw)])
                if p["subtype"] == 13 and body:
                    # Search action frames for printable islands.
                    for m in re.finditer(rb"[ -~]{4,}", body):
                        res["action_printable"].append([fn, rec["frame"], p["body_off"] + m.start(), body[0] if body else None, hexdump(m.group()), m.group().decode("ascii", "replace")])
            elif p["type"] == 2:
                ep, ep_off = llc_eapol(p)
                if ep is not None and len(ep) >= 4:
                    ver, typ, ln = ep[0], ep[1], struct.unpack_from(">H", ep, 2)[0]
                    res["eap"][(ver, typ, ln)] += 1
                    if len(res["eap_examples"][(ver, typ, ln)]) < 10:
                        res["eap_examples"][(ver, typ, ln)].append([fn, rec["frame"], ep_off, p["addr"], hexdump(ep[:80])])
                    if typ == 0 and len(ep) >= 8:  # EAP packet
                        code, eid, elen = ep[4], ep[5], struct.unpack_from(">H", ep, 6)[0]
                        etype = ep[8] if len(ep) >= 9 else None
                        payload = ep[9 : 4 + elen] if etype is not None else b""
                        key = (code, etype, payload.decode("latin1", "replace") if etype == 1 else hexdump(payload, 48))
                        res["eap_identity"][key] += 1
                        if len(res["eap_identity_examples"][key]) < 8:
                            res["eap_identity_examples"][key].append([fn, rec["frame"], ep_off + 4, p["addr"], hexdump(ep[4 : 4 + min(elen, 96)])])
                    if typ == 3 and len(ep) >= 99:  # key descriptor-ish
                        # WPA key: descriptor, key_info, key_len, replay, nonce, iv, rsc, id, mic, data_len
                        desc = ep[4]
                        key_info = struct.unpack_from(">H", ep, 5)[0] if len(ep) >= 7 else None
                        replay = struct.unpack_from(">Q", ep, 9)[0] if len(ep) >= 17 else None
                        nonce = ep[17:49]
                        mic = ep[81:97] if len(ep) >= 97 else b""
                        kdl = struct.unpack_from(">H", ep, 97)[0] if len(ep) >= 99 else None
                        keydata = ep[99 : 99 + min(kdl or 0, 64)]
                        interesting = is_printable(nonce, 0.5) or is_printable(keydata, 0.7) or replay in (42, 1337, 20260916)
                        res["eapol_key"].append([fn, rec["frame"], ep_off, desc, key_info, replay, hexdump(nonce), printable(nonce), kdl, hexdump(keydata), printable(keydata), interesting])
    return res


def serializable(obj):
    if isinstance(obj, collections.Counter):
        return obj.most_common()
    if isinstance(obj, collections.defaultdict):
        return dict(obj)
    return obj


def main():
    res = summarize()
    # Print compact but information-rich summaries.
    print("PCAP headers")
    for fn, hdr in res["pcap"].items():
        print(fn, hdr)
    print("\nFrame counts")
    for k, v in sorted(res["frame_counts"].items()):
        print(k, v)
    print("\nSSIDs")
    for s, c in res["ssid"].most_common():
        print(c, repr(s), res["ssid_examples"][s][:5])
    print("\nVendor IEs")
    for k, c in res["vendor"].most_common(80):
        print(c, k, res["vendor_examples"][k][:5])
    print("\nExtended IEs")
    for k, c in res["ext"].most_common(80):
        print(c, k, res["ext_examples"][k][:5])
    print("\nOdd printable IEs")
    for row in res["odd_ie"][:300]:
        print(row)
    print("\nEAP identities")
    for k, c in res["eap_identity"].most_common(100):
        print(c, k, res["eap_identity_examples"][k][:5])
    print("\nEAPOL packet classes")
    for k, c in res["eap"].most_common(50):
        print(c, k, res["eap_examples"][k][:3])
    print("\nInteresting EAPOL keys")
    for row in res["eapol_key"]:
        if row[-1]:
            print(row)
    print("\nStatus/reason")
    for k, c in res["rare_status_reason"].most_common(80):
        print(c, k, res["status_reason_examples"][k][:5])
    print("\nRaw printable strings with count <= 40 and meaningful chars")
    for s, c in sorted(res["raw_printables"].items(), key=lambda kv: (kv[1], kv[0].lower())):
        if c <= 40 and (re.search(r"[A-Za-z]{3,}", s) or re.search(r"20[0-9]{2}|42|1337|S3XY|Tesla|TESLA|Elon|Mars|B2A1", s, re.I)):
            print(c, repr(s), res["raw_printable_examples"][s])
    print("\nMAC summary rare <=3 / wordish")
    word_hex = set("abcdef")
    for a, c in sorted(res["macs"].items(), key=lambda kv: (kv[1], kv[0])):
        hexs = a.replace(":", "")
        wordish = any(x in hexs for x in ["c0ffee", "baddad", "decade", "facade", "dead", "beef", "cafe", "1337", "42", "5e"])
        laa = int(a[:2], 16) & 2
        if c <= 3 or wordish or laa:
            print(c, a, "laa" if laa else "", res["mac_examples"][a][:5])
    print("\nAction printables")
    for row in res["action_printable"][:200]:
        print(row)
    # JSON sidecar for follow-up without reparsing.
    def conv(x):
        if isinstance(x, bytes):
            return x.hex()
        if isinstance(x, tuple):
            return list(x)
        if isinstance(x, collections.Counter):
            return [[conv(k), v] for k, v in x.most_common()]
        if isinstance(x, collections.defaultdict):
            return {str(k): conv(v) for k, v in x.items()}
        if isinstance(x, dict):
            return {str(k): conv(v) for k, v in x.items()}
        if isinstance(x, list):
            return [conv(v) for v in x]
        return x
    with open("airframe_analysis_summary.json", "w", encoding="utf-8") as f:
        json.dump(conv(res), f)


if __name__ == "__main__":
    main()
