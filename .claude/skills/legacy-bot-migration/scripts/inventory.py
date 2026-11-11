#!/usr/bin/env python3
"""Inventory a legacy bot export (.tgz) or bot folder and check it against bot-engine's supported scope.

  inventory.py <bot.tgz | bot-dir> [--json]

Prints a markdown report. Secrets-looking literals are only COUNTED per file, never printed.
Run with `python3 -I` when the archive comes from an untrusted source (it is only read, never executed).
"""
import io, json, os, re, sys, tarfile
from collections import Counter, defaultdict

SUPPORTED_CONTENT = {"builtin_text", "builtin_single-choice", "builtin_carousel", "builtin_card", "builtin_image", "builtin_file"}
BUILTINS = {"builtin/setVariable", "builtin/removeVariable", "builtin/resetSession", "builtin/resetContext",
            "builtin/appendContext", "builtin/incrementNumberOfConversations", "builtin/getGlobalVariable",
            "builtin/resetGlobalVariable", "builtin/wait", "basic-skills/choice_parse_answer",
            "basic-skills/choice_invalid_answer"}
ALLOWED_BP = {"cms.renderElement", "events.replyToEvent", "database.insertAndRetrieve"}
ALLOWED_REQUIRE = {"axios", "form-data", "qs", "moment", "crypto", "lodash"}
SECRET_PATTERNS = [
    ("telegram bot token", re.compile(r"bot\d{6,12}:[A-Za-z0-9_-]{20,}")),
    ("basic auth literal", re.compile(r"Basic\s+[A-Za-z0-9+/=]{12,}")),
    ("bearer/jwt literal", re.compile(r"(Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.)")),
    ("credential assignment", re.compile(r"(?i)(password|passwd|api[_-]?key|secret|client_secret|token)\s*[:=]\s*['\"`][^'\"`\s]{6,}['\"`]")),
]


def load(path):
    files = {}
    if os.path.isdir(path):
        for dp, _, fns in os.walk(path):
            for fn in fns:
                full = os.path.join(dp, fn)
                files[os.path.relpath(full, path)] = open(full, "rb").read()
    else:
        with tarfile.open(path) as t:
            for m in t.getmembers():
                if m.isfile():
                    files[m.name] = t.extractfile(m).read()
    out = {}
    for p, b in files.items():
        p = p.lstrip("./") if p.startswith("./") else p
        base = p.split("/")[-1]
        if "__MACOSX" in p or base.startswith("._") or base == ".DS_Store":
            continue
        out[p] = b
    # Archives sometimes wrap everything in one top folder.
    if "bot.config.json" not in out:
        roots = {p.split("/")[0] for p in out if p.endswith("bot.config.json") and p.count("/") == 1}
        if len(roots) == 1:
            r = roots.pop() + "/"
            out = {p[len(r):]: b for p, b in out.items() if p.startswith(r)}
    return out


def js(b):
    return json.loads(b.decode("utf8"))


def main(argv):
    if not argv:
        sys.exit(__doc__)
    files = load(argv[0])
    as_json = "--json" in argv
    rep = defaultdict(list)
    out_of_scope, warnings = [], []

    cfg = js(files["bot.config.json"]) if "bot.config.json" in files else {}
    if not cfg:
        out_of_scope.append("bot.config.json missing")

    flows = {p[6:]: js(b) for p, b in files.items() if p.startswith("flows/") and p.endswith(".flow.json")}
    elements, el_types = {}, Counter()
    for p, b in files.items():
        if p.startswith("content-elements/") and p.endswith(".json"):
            ctype = p.split("/")[-1][:-5]
            for e in js(b):
                elements[e["id"]] = (ctype, e.get("formData", {}))
                el_types[ctype] += 1
    actions = {p[8:-3]: b.decode("utf8", "ignore") for p, b in files.items() if p.startswith("actions/") and p.endswith(".js")}
    hooks = {p[6:]: b.decode("utf8", "ignore") for p, b in files.items() if p.startswith("hooks/") and p.endswith(".js")}

    node_types, skills, builtin_use, custom_use = Counter(), Counter(), Counter(), Counter()
    nodes_total, transitions_total, nlu_conds, catchalls = 0, 0, [], 0
    missing_el, missing_act, dangling = set(), set(), []
    triggers = []
    for fname, f in sorted(flows.items()):
        names = {n.get("name") for n in f.get("nodes", [])}
        if f.get("catchAll", {}).get("next") or f.get("catchAll", {}).get("onReceive"):
            catchalls += 1
        for n in f.get("nodes", []):
            nodes_total += 1
            t = n.get("type") or "standard"
            node_types[t] += 1
            if t not in ("standard", "skill-call"):
                out_of_scope.append(f"flows/{fname}: node {n.get('name')} has type {t}")
            if t == "skill-call":
                skills[n.get("skill")] += 1
                if n.get("skill") != "choice":
                    out_of_scope.append(f"flows/{fname}: node {n.get('name')} uses skill {n.get('skill')}")
            for ins in (n.get("onEnter") or []) + (n.get("onReceive") or []):
                head, _, rest = ins.partition(" ")
                if head == "say":
                    if rest.startswith("@"):
                        out_of_scope.append(f"flows/{fname}: node {n.get('name')} uses inline `say @…`")
                    elif rest.startswith("#!") and rest[2:].split()[0] not in elements:
                        missing_el.add(rest[2:].split()[0])
                elif head in BUILTINS:
                    builtin_use[head] += 1
                elif head.startswith(("builtin/", "basic-skills/")) or ("/" in head and head.split("/")[0] not in {a.split("/")[0] for a in actions}):
                    if head.startswith(("builtin/", "basic-skills/")):
                        out_of_scope.append(f"flows/{fname}: node {n.get('name')} uses unsupported builtin {head}")
                    elif head not in actions:
                        missing_act.add(head)
                else:
                    custom_use[head] += 1
                    if head not in actions:
                        missing_act.add(head)
            for tr in n.get("next") or []:
                transitions_total += 1
                c, tgt = tr.get("condition", ""), tr.get("node", "")
                if "event.nlu" in c:
                    nlu_conds.append(f"flows/{fname}:{n.get('name')}")
                if tgt and not tgt.startswith("#") and tgt != "END":
                    fl, _, nd = tgt.partition("#") if (".flow.json" in tgt) else ("", "", tgt)
                    if fl and fl not in flows:
                        dangling.append(f"flows/{fname}:{n.get('name')} → {tgt}")
                    elif not fl and nd not in names:
                        dangling.append(f"flows/{fname}:{n.get('name')} → {tgt}")
                if fname == "main.flow.json" and n.get("name") == f.get("startNode"):
                    triggers += re.findall(r"event\.(?:preview|payload\.text)\s*===?\s*['\"]([^'\"]+)['\"]", c)

    for t in el_types:
        if t not in SUPPORTED_CONTENT:
            out_of_scope.append(f"content-elements/{t}.json: content type {t} not supported ({el_types[t]} elements)")
    for eid, (t, fd) in elements.items():
        s = json.dumps(fd, ensure_ascii=False)
        if re.search(r"\{\{[#^/>]", s):
            out_of_scope.append(f"content-elements/{t}.json: {eid} uses Mustache sections/partials")

    bp_use, req_use, hosts, risky, secrets = Counter(), Counter(), Counter(), [], Counter()
    for name, code in {**{f"actions/{k}.js": v for k, v in actions.items()}, **{f"hooks/{k}": v for k, v in hooks.items()}}.items():
        for m in re.findall(r"\bbp\.([a-zA-Z]+(?:\.[a-zA-Z]+)?)", code):
            bp_use[m] += 1
            if not m.startswith("logger") and m not in ALLOWED_BP:
                out_of_scope.append(f"{name}: uses bp.{m}")
        for m in re.findall(r"require\(\s*([^)]*)\)", code):
            lit = m.strip().strip("'\"`")
            req_use[lit] += 1
            if not re.fullmatch(r"['\"`][^'\"`]+['\"`]", m.strip()):
                out_of_scope.append(f"{name}: non-literal require({m.strip()})")
            elif lit.startswith("."):
                out_of_scope.append(f"{name}: relative require('{lit}')")
            elif lit not in ALLOWED_REQUIRE:
                out_of_scope.append(f"{name}: require('{lit}') not available")
        for kw in ("setTimeout", "setInterval", "process.env", "Intl."):
            if kw in code:
                risky.append(f"{name}: uses {kw}")
        for scheme, host, port in re.findall(r"(https?)://([A-Za-z0-9.-]+)(?::(\d+))?", code):
            hosts[f"{host}:{port or (443 if scheme == 'https' else 80)}"] += 1
        for label, pat in SECRET_PATTERNS:
            k = len(pat.findall(code))
            if k:
                secrets[(name, label)] += k
    for h in hooks:
        if not h.startswith("before_conversation_end/"):
            out_of_scope.append(f"hooks/{h}: hook type not supported")
    if nlu_conds:
        warnings.append(f"{len(nlu_conds)} transition(s) test event.nlu (always false in bot-engine, as in the legacy engine with NLU off): " + ", ".join(nlu_conds[:8]))
    ignored = sorted({p.split('/')[0] for p in files if p.split('/')[0] in ("qna", "intents", "entities", "models")})
    if ignored:
        warnings.append("ignored folders (NLU/QnA data): " + ", ".join(ignored))
    if missing_el:
        warnings.append(f"{len(missing_el)} say instruction(s) reference missing elements: " + ", ".join(sorted(missing_el)[:8]))
    if missing_act:
        warnings.append(f"{len(missing_act)} action(s) referenced but missing: " + ", ".join(sorted(missing_act)[:8]))
    if dangling:
        warnings.append(f"{len(dangling)} dangling transition target(s): " + ", ".join(dangling[:8]))

    data = {
        "bot": {"id": cfg.get("id"), "name": cfg.get("name"), "version": cfg.get("version"),
                "languages": cfg.get("languages"), "timeoutInterval": (cfg.get("dialog") or {}).get("timeoutInterval"),
                "maxMessageLength": (cfg.get("converse") or {}).get("maxMessageLength")},
        "counts": {"files": len(files), "flows": len(flows), "skill_flows": sum(1 for f in flows if f.startswith("skills/")),
                   "nodes": nodes_total, "transitions": transitions_total, "flows_with_catchAll": catchalls,
                   "content_elements": sum(el_types.values()), "actions": len(actions), "hooks": len(hooks)},
        "node_types": dict(node_types), "skills": dict(skills), "content_types": dict(el_types),
        "builtin_actions": dict(builtin_use), "custom_actions_used": dict(custom_use), "bp_usage": dict(bp_use),
        "require": dict(req_use), "external_hosts": dict(hosts), "start_triggers": triggers,
        "secrets_found": {f"{k[0]} ({k[1]})": v for k, v in secrets.items()},
        "risky_js": risky, "out_of_scope": sorted(set(out_of_scope)), "warnings": warnings,
    }
    data["verdict"] = "blocked: out-of-scope features" if data["out_of_scope"] else (
        "ready (review warnings)" if warnings or risky else "ready")
    if as_json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return
    b, c = data["bot"], data["counts"]
    p = print
    p(f"# Inventory: {b['id']} ({b['name']})\n")
    p(f"**Verdict:** {data['verdict']}\n")
    p(f"- legacy version {b['version']}, languages {b['languages']}, dialog.timeoutInterval {b['timeoutInterval'] or 'global default'}, maxMessageLength {b['maxMessageLength'] or 'default 360'}")
    p(f"- {c['flows']} flows ({c['skill_flows']} skill flows), {c['nodes']} nodes, {c['transitions']} transitions, {c['flows_with_catchAll']} flow(s) with flow-wide transitions")
    p(f"- {c['content_elements']} content elements: {dict(el_types)}")
    p(f"- node types {dict(node_types)}; skills {dict(skills) or 'none'}")
    p(f"- builtin actions: {dict(builtin_use) or 'none'}")
    p(f"- custom actions ({c['actions']} files): used {dict(custom_use) or 'none'}; hooks: {list(hooks) or 'none'}")
    p(f"- bp.* usage: {dict(bp_use) or 'none'}; require: {dict(req_use) or 'none'}")
    p(f"- start-node trigger texts (main): {triggers or 'none — any first message starts the flow'}")
    p("\n## External hosts called by actions (stub these in tests; never hit them from a test)\n")
    for h, k in sorted(hosts.items()):
        p(f"- {h} ({k}×)")
    if not hosts:
        p("- none")
    p("\n## Secrets-looking literals (counts only — do not copy the bot into a repo)\n")
    for k, v in data["secrets_found"].items():
        p(f"- {k}: {v}")
    if not secrets:
        p("- none found by heuristics")
    p("\n## Out of scope (must be rewritten before migration)\n")
    for x in data["out_of_scope"] or ["none"]:
        p(f"- {x}")
    p("\n## Warnings\n")
    for x in (warnings + risky) or ["none"]:
        p(f"- {x}")


if __name__ == "__main__":
    main(sys.argv[1:])
