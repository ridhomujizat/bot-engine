#!/usr/bin/env python3
"""flowkit — build bot-engine bots (legacy flow format) from Python.

API summary
-----------
    from flowkit import Bot, pick, any_of, set_var, run

    bot = Bot("demo", name="Demo", timeout="10m")        # bot.config.json
    hi   = bot.text("Halo {{event.payload.metadata.cust_name}}!")   # -> 'say #!builtin_text-xxxxxx'
    menu = bot.choice("Mau apa?", ["Info", "Tagihan"])    # single-choice (buttons); dropdown=True for a select
    img  = bot.image("https://example.test/a.png", title="Promo")
    car  = bot.carousel([dict(title="A", subtitle="..", image="https://..", actions=[("Pilih A", "A")])])
    bot.action("cek-nomor", "temp.ok = /^\\d{10}$/.test(event.preview)")   # actions/cek-nomor.js (JSDoc added)
    bot.hook("before_conversation_end", "log-end", "bp.logger.info('end')")

    main = bot.flow("main")                                # flows/main.flow.json; first node = start node
    main.node("entry", on_enter=[set_var("session", "nama", "{{event.payload.metadata.cust_name}}"), hi],
              next=[("true", "menu")])
    main.node("menu", on_enter=[menu], wait=True,          # wait=True -> onReceive [] (waits for the user)
              next=[(pick("Info"), "info.flow.json"), (pick("Tagihan"), "tagihan.flow.json"), ("true", "menu")])
    bot.choice_skill(main, "pilih", question=menu_id, choices={"Info": "info.flow.json"}, fallback="END")

    bot.write("/tmp/out")                                  # -> /tmp/out/demo/...

Transition targets: node name in the same flow | "other.flow.json" | "other.flow.json#node" | "#" (return to
caller) | "##" (caller flow start) | "END". Conditions are JS expressions over event/session/temp/user.
Element ids and node ids are derived from content, so rebuilding the same script gives the same ids.
error.flow.json and timeout.flow.json are added with a default message unless you define them.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import string
import sys
from typing import Any, Iterable

_ALNUM = string.ascii_letters + string.digits


def _hid(seed: str, n: int, alphabet: str = _ALNUM) -> str:
    h = int(hashlib.sha1(seed.encode("utf8")).hexdigest(), 16)
    out = []
    for _ in range(n):
        h, r = divmod(h, len(alphabet))
        out.append(alphabet[r])
    return "".join(out)


def pick(value: str) -> str:
    """Condition matching a typed text or clicked button title."""
    lit = "'" + value.replace("\\", "\\\\") + "'" if "'" not in value else json.dumps(value, ensure_ascii=False)
    return "event.preview === " + lit


def any_of(*values: str) -> str:
    return " || ".join(pick(v) for v in values)


def set_var(kind: str, name: str, value: Any) -> str:
    """builtin/setVariable instruction. kind: user | session | temp | bot. value may contain {{mustache}}."""
    assert kind in ("user", "session", "temp", "bot"), kind
    return "builtin/setVariable " + json.dumps({"type": kind, "name": name, "value": value}, ensure_ascii=False, separators=(",", ":"))


def run(action: str, **args: Any) -> str:
    """Instruction calling a builtin or custom action with JSON args."""
    return f"{action} " + json.dumps(args, ensure_ascii=False, separators=(",", ":"))


class Flow:
    def __init__(self, bot: "Bot", name: str):
        self.bot, self.name, self.nodes, self.catch_all = bot, name, [], {}
        self.skill_data: dict | None = None
        self.positions: dict[str, dict] = {}

    @property
    def file(self) -> str:
        return f"{self.name}.flow.json"

    def node(self, name: str, on_enter: Iterable[str] = (), on_receive: Iterable[str] | None = None,
             wait: bool = False, next: Iterable[tuple] = (), pos: tuple[int, int] | None = None, **extra) -> dict:
        """Add a standard node. next: (condition, target) or (condition, target, caption)."""
        if any(n["name"] == name for n in self.nodes):
            raise ValueError(f"{self.file}: duplicate node {name!r}")
        recv = list(on_receive) if on_receive is not None else ([] if wait else None)
        n = {"id": _hid(f"{self.name}/{name}", 10, "0123456789abcdef"), "name": name, "type": "standard",
             "onEnter": list(on_enter), "onReceive": recv, "next": [self._tr(t) for t in next], **extra}
        self.nodes.append(n)
        if pos:
            self.positions[n["id"]] = {"x": pos[0], "y": pos[1]}
        return n

    def flow_wide(self, next: Iterable[tuple] = (), on_receive: Iterable[str] = ()) -> None:
        """catchAll: transitions/on-receive evaluated on every message in this flow."""
        self.catch_all = {"next": [self._tr(t) for t in next], "onReceive": list(on_receive)}

    @staticmethod
    def _tr(t: tuple) -> dict:
        cond, target = t[0], t[1]
        d = {"condition": cond, "node": target}
        if len(t) > 2 and t[2]:
            d = {"caption": t[2], **d}
        return d

    # -- serialisation -------------------------------------------------------------------------
    def to_json(self) -> dict:
        d: dict = {"version": "0.0.1", "catchAll": self.catch_all, "startNode": self.nodes[0]["name"]}
        if self.skill_data is not None:
            d["skillData"] = self.skill_data
        d["nodes"] = self.nodes
        return d

    def ui_json(self) -> dict:
        if self.skill_data is not None:  # legacy skill flows store empty positions
            return {"nodes": [{"id": n["id"], "position": {}} for n in self.nodes]}
        pos = dict(self._auto_layout())
        pos.update(self.positions)
        return {"nodes": [{"id": n["id"], "position": pos[n["id"]]} for n in self.nodes], "links": []}

    def _auto_layout(self):
        """Left-to-right layers by BFS depth from the start node; rows stacked by estimated height."""
        by_name = {n["name"]: n for n in self.nodes}
        depth = {self.nodes[0]["name"]: 0}
        queue = [self.nodes[0]["name"]]
        while queue:
            cur = queue.pop(0)
            for t in by_name[cur]["next"]:
                tgt = t["node"]
                if tgt in by_name and tgt not in depth:
                    depth[tgt] = depth[cur] + 1
                    queue.append(tgt)
        maxd = max(depth.values(), default=0)
        for n in self.nodes:
            depth.setdefault(n["name"], maxd + 1)
        col_y: dict[int, int] = {}
        for n in self.nodes:
            c = depth[n["name"]]
            y = col_y.get(c, 100)
            rows = len(n.get("onEnter") or []) + len(n.get("onReceive") or []) + len(n.get("next") or [])
            col_y[c] = y + 140 + 30 * rows + 40
            yield n["id"], {"x": 100 + 380 * c, "y": y}


class Bot:
    def __init__(self, bot_id: str, name: str | None = None, language: str = "en", timeout: str = "10m",
                 description: str = ""):
        self.id, self.name, self.lang = bot_id, name or bot_id, language
        self.timeout, self.description = timeout, description
        self.flows: dict[str, Flow] = {}
        self.elements: dict[str, list] = {}
        self.actions: dict[str, str] = {}
        self.hooks: dict[tuple[str, str], str] = {}

    # -- content elements ----------------------------------------------------------------------
    def element(self, ctype: str, form: dict, eid: str | None = None) -> str:
        """Add a content element (formData keys WITHOUT language suffix) and return 'say #!<id>'."""
        L = self.lang
        fd = {f"{k}${L}": v for k, v in form.items() if v is not None}
        eid = eid or f"{ctype}-{_hid(ctype + json.dumps(fd, sort_keys=True, ensure_ascii=False), 6)}"
        arr = self.elements.setdefault(ctype, [])
        if not any(e["id"] == eid for e in arr):
            arr.append({"id": eid, "formData": fd, "createdBy": "admin",
                        "createdOn": "2026-01-01T00:00:00.000Z", "modifiedOn": "2026-01-01T00:00:00.000Z"})
        return f"say #!{eid}"

    def text(self, text: str, typing: bool = True, markdown: bool = False, variations: list[str] | None = None,
             eid: str | None = None) -> str:
        return self.element("builtin_text", {"text": text, "variations": variations, "typing": typing,
                                             "markdown": markdown}, eid)

    def choice(self, text: str, options: Iterable, dropdown: bool = False, placeholder: str | None = None,
               typing: bool = True, eid: str | None = None) -> str:
        """options: ['A', 'B'] or [('Title', 'value'), ...]."""
        ch = [{"title": o, "value": o} if isinstance(o, str) else {"title": o[0], "value": o[1]} for o in options]
        form = {"text": text, "choices": ch, "typing": typing}
        if dropdown:
            form.update(isDropdown=True, dropdownPlaceholder=placeholder or "Select...")
        return self.element("builtin_single-choice", form, eid)

    def image(self, url: str, title: str | None = None, typing: bool = True, eid: str | None = None) -> str:
        return self.element("builtin_image", {"image": url, "title": title, "typing": typing}, eid)

    def file(self, url: str, title: str | None = None, typing: bool = True, eid: str | None = None) -> str:
        return self.element("builtin_file", {"file": url, "title": title, "typing": typing}, eid)

    @staticmethod
    def _actions(actions):
        out = []
        for a in actions or []:
            if isinstance(a, dict):
                out.append(a)
            elif len(a) == 2:  # (title, text) -> say the text back as the user's message
                out.append({"action": "Say something", "title": a[0], "text": a[1]})
            else:  # (title, 'url', url)
                out.append({"action": "Open URL", "title": a[0], "url": a[2]})
        return out

    def card(self, title: str, subtitle: str = "", image: str | None = None, actions=None, eid: str | None = None) -> str:
        return self.element("builtin_card", {"title": title, "subtitle": subtitle, "image": image,
                                             "actions": self._actions(actions)}, eid)

    def carousel(self, cards: list[dict], typing: bool = True, eid: str | None = None) -> str:
        items = [{"title": c["title"], "subtitle": c.get("subtitle", ""), "image": c.get("image"),
                  "actions": self._actions(c.get("actions"))} for c in cards]
        return self.element("builtin_carousel", {"items": items, "typing": typing}, eid)

    # -- flows, actions, hooks -----------------------------------------------------------------
    def flow(self, name: str) -> Flow:
        if name.endswith(".flow.json"):
            name = name[: -len(".flow.json")]
        if name in self.flows:
            raise ValueError(f"duplicate flow {name}")
        f = self.flows[name] = Flow(self, name)
        return f

    def action(self, name: str, code: str, title: str | None = None, description: str = "") -> str:
        """actions/<name>.js. The body runs as an async function(bp, event, user, temp, session, args)."""
        header = f"/**\n * {description or title or name}\n * @title {title or name}\n * @category Custom\n */\n"
        self.actions[name] = code if code.lstrip().startswith("/**") else header + code.strip() + "\n"
        return name

    def hook(self, hook_type: str, name: str, code: str) -> None:
        assert hook_type == "before_conversation_end", "only before_conversation_end hooks are supported"
        self.hooks[(hook_type, name)] = code

    def choice_skill(self, flow: Flow, name: str, question: str, choices: dict[str, str], fallback: str = "END",
                     keywords: dict[str, list[str]] | None = None, max_retries: int = 3, invalid: str | None = None,
                     repeat_on_invalid: bool = False, variable: str = "", seed: str | None = None) -> dict:
        """Insert a legacy choice skill node (+ skills/choice-xxxxxx.flow.json).

        question: 'say #!builtin_single-choice-...' returned by bot.choice(); choices: {value: target};
        fallback: target after max retries ("On failure"). The node name is choice-<6> unless `name` given.
        """
        content_id = question.split()[1][2:]
        rid6 = _hid(seed or f"{flow.name}/{name}", 6, "0123456789")
        rand = _hid("rid" + (seed or f"{flow.name}/{name}"), 10, string.ascii_lowercase + string.digits)
        kw = keywords or {v: [v] for v in choices}
        inv = invalid.split()[1][2:] if invalid else ""
        cfg = {"nbMaxRetries": max_retries, "repeatChoicesOnInvalid": repeat_on_invalid, "variableName": variable}
        parse_args = {"randomId": rand, "contentId": content_id, "invalidContentId": inv, "keywords": kw, "config": cfg}
        sk = self.flow(f"skills/choice-{rid6}")
        sk.skill_data = {"randomId": rand, "contentId": content_id, "invalidContentId": inv, "keywords": kw, "config": cfg}
        sk.catch_all = {"next": []}
        say_q = f"say #!{content_id} " + '{"skill":"choice"}'

        def n(nm, nid, on_enter, nxt, on_receive=None, **extra):
            d = {"name": nm}
            if on_receive is not None:
                d["onReceive"] = on_receive
            d.update({"next": [{"condition": c, "node": t} for c, t in nxt], **extra, "onEnter": on_enter, "id": nid})
            return d

        sk.nodes = [
            n("entry", _hid(rand + "e", 6, "0123456789"), [
                'builtin/setVariable {"type":"temp","name":"skill-choice-invalid-count-%s","value": 0}' % rand,
                'builtin/setVariable {"type":"temp","name":"skill-choice-valid-%s","value": null}' % rand,
                'builtin/setVariable {"type":"temp","name":"skill-choice-ret-%s","value": null}' % rand, say_q],
              [("true", "parse")]),
            n("parse", _hid(rand + "p", 6, "0123456789"), [],
              [(f"temp['skill-choice-valid-{rand}'] === true", "#"), ("true", "invalid")],
              on_receive=["basic-skills/choice_parse_answer " + json.dumps(parse_args, ensure_ascii=False, separators=(",", ":"))],
              triggers=[{"conditions": [{"id": "always"}]}]),
            n("invalid", _hid(rand + "i", 6, "0123456789"),
              ["basic-skills/choice_invalid_answer " + json.dumps({"randomId": rand}, separators=(",", ":"))],
              [(f"Number(temp['skill-choice-invalid-count-{rand}']) > Number({max_retries})", "#"), ("true", "sorry")]),
            n("sorry", _hid(rand + "s", 6, "0123456789"), ([say_q] if repeat_on_invalid else ([f"say #!{inv}"] if inv else [])),
              [("true", "parse")]),
        ]
        nxt = []
        for value, target in choices.items():
            label = value if len(value) <= 8 else value[:7] + "..."
            nxt.append({"caption": f"User picked [{label}]",
                        "condition": f"temp['skill-choice-ret-{rand}'] == " + json.dumps(value, ensure_ascii=False),
                        "node": target})
        nxt.append({"caption": "On failure", "condition": "true", "node": fallback})
        node = {"id": f"skill-{rid6}", "type": "skill-call", "skill": "choice", "name": name or f"choice-{rid6}",
                "flow": sk.file, "next": nxt, "onEnter": None, "onReceive": None}
        flow.nodes.append(node)
        return node

    # -- output --------------------------------------------------------------------------------
    def _defaults(self) -> None:
        if "error" not in self.flows:
            self.flow("error").node("entry", on_enter=[self.text("Maaf, terjadi kesalahan. Silakan coba lagi.")])
        if "timeout" not in self.flows:
            self.flow("timeout").node("entry", on_enter=[self.text("Sesi berakhir karena tidak ada aktivitas.")],
                                      next=[("true", "END")])

    def check(self) -> list[str]:
        """Cheap local checks (the engine validator in validate.sh is authoritative)."""
        issues, files = [], {f.file for f in self.flows.values()}
        ids = {e["id"] for arr in self.elements.values() for e in arr}
        for f in self.flows.values():
            names = {n["name"] for n in f.nodes}
            for n in f.nodes:
                for ins in (n.get("onEnter") or []) + (n.get("onReceive") or []):
                    head = ins.split(" ", 1)[0]
                    if head == "say" and ins.split()[1][2:] not in ids:
                        issues.append(f"{f.file}:{n['name']}: unknown content {ins}")
                    elif head not in ("say",) and "/" not in head and head not in self.actions:
                        issues.append(f"{f.file}:{n['name']}: unknown action {head}")
                for t in n.get("next") or []:
                    tgt = t["node"]
                    if tgt in ("", "#", "##", "END") or tgt.startswith("#"):
                        continue
                    fl, _, nd = tgt.partition("#") if tgt.endswith(".flow.json") or "#" in tgt else ("", "", tgt)
                    if fl:
                        if fl not in files:
                            issues.append(f"{f.file}:{n['name']}: target flow {fl} missing")
                        elif nd and nd not in {x['name'] for x in self.flows[fl[:-10]].nodes}:
                            issues.append(f"{f.file}:{n['name']}: target node {tgt} missing")
                    elif nd not in names:
                        issues.append(f"{f.file}:{n['name']}: target node {nd} missing")
        return issues

    def write(self, out_dir: str, overwrite: bool = True) -> str:
        self._defaults()
        problems = self.check()
        if problems:
            raise SystemExit("flowkit check failed:\n  " + "\n  ".join(problems))
        root = os.path.join(out_dir, self.id)
        if os.path.exists(root):
            if not overwrite:
                raise SystemExit(f"{root} exists")
            if not os.path.exists(os.path.join(root, "bot.config.json")):
                raise SystemExit(f"refusing to delete {root}: not a bot folder")
            shutil.rmtree(root)

        def put(rel, data, raw=False):
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf8") as fh:
                fh.write(data if raw else json.dumps(data, indent=2, ensure_ascii=False))

        put("bot.config.json", {
            "locked": False, "disabled": False, "private": False, "details": {}, "description": self.description,
            "active": True, "version": "12.31.8", "author": "flowkit", "license": "AGPL-3.0",
            "imports": {"modules": [], "incomingMiddleware": [], "outgoingMiddleware": [],
                        "contentTypes": ["builtin_card", "builtin_carousel", "builtin_file", "builtin_image",
                                         "builtin_single-choice", "builtin_text"]},
            "dialog": {"timeoutInterval": self.timeout}, "logs": {"expiration": "1 week"},
            "defaultLanguage": self.lang, "languages": [self.lang], "id": self.id, "name": self.name})
        for f in self.flows.values():
            put(f"flows/{f.file}", f.to_json())
            put(f"flows/{f.name}.ui.json", f.ui_json())
        for ctype, arr in self.elements.items():
            put(f"content-elements/{ctype}.json", arr)
        for name, code in self.actions.items():
            put(f"actions/{name}.js", code, raw=True)
        for (htype, name), code in self.hooks.items():
            put(f"hooks/{htype}/{name}.js", code, raw=True)
        return root


if __name__ == "__main__":
    if "--help-api" in sys.argv or len(sys.argv) == 1:
        print(__doc__)
