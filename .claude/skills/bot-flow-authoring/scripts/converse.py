#!/usr/bin/env python3
"""Talk to a bot through bot-engine's converse API, the same call the downstream worker makes.

  converse.py <bot-id> <message> [<message> ...] [--user ID] [--meta key=value ...] [--raw]

Env BASE (default http://localhost:3000), EMAIL and PASSWORD (required).
Each message is sent in order on one user id (new random id unless --user). Prints replies compactly with the
current flow/node after each turn; --raw prints the full JSON. Metadata mimics the downstream worker (sid, unique_id,
accountId, channel_sources, new_session on the first message); --meta adds/overrides keys (dot paths ok).
"""
import json, os, random, string, sys, urllib.request

def post(url, body, token=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()[:500]}")

def setpath(d, path, value):
    *head, last = path.split(".")
    for k in head:
        d = d.setdefault(k, {})
    d[last] = value

def show(r):
    t = r.get("type")
    s = r.get("text") or r.get("title") or ""
    if t == "single-choice":
        s += "  [" + " | ".join(c["title"] for c in r.get("choices", [])) + "]" + (" (dropdown)" if r.get("isDropdown") else "")
    elif t == "carousel":
        s = "carousel: " + " | ".join(i.get("title", "") for i in r.get("items", []))
    elif t in ("image", "file"):
        s = f"{t}: {r.get('title') or ''} {r.get(t) or ''}".strip()
    return f"  bot> {s}"

def main(argv):
    base = os.environ.get("BASE", "http://localhost:3000")
    raw, user, msgs, meta = False, None, [], {}
    it = iter(argv)
    for a in it:
        if a == "--raw": raw = True
        elif a == "--user": user = next(it)
        elif a == "--meta":
            k, _, v = next(it).partition("=")
            setpath(meta, k, v)
        else: msgs.append(a)
    if len(msgs) < 2:
        sys.exit(__doc__)
    bot, msgs = msgs[0], msgs[1:]
    user = user or "agent-" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    jwt = post(f"{base}/api/v1/auth/login/basic/default", {"email": os.environ["EMAIL"],
               "password": os.environ["PASSWORD"]})["payload"]["jwt"]
    for i, m in enumerate(msgs):
        md = {"sid": f"sid-{user}", "unique_id": user, "accountId": user, "channel_sources": "whatsapp",
              "new_session": i == 0}
        for k, v in meta.items():
            md[k] = v
        res = post(f"{base}/api/v1/bots/{bot}/converse/{user}/secured?include=state,suggestions,decision,nlu",
                   {"type": "text", "text": m, "metadata": md}, jwt)
        ctx = res.get("state", {}).get("context", {})
        print(f"user> {m}")
        if raw:
            print(json.dumps(res, indent=2, ensure_ascii=False))
        else:
            for r in res.get("responses", []):
                print(show(r))
            print(f"  @ {ctx.get('currentFlow')} / {ctx.get('currentNode')}")

if __name__ == "__main__":
    main(sys.argv[1:])
