# bot-engine HTTP API: contract notes for the editor UI

Base URL: the pod's `EXTERNAL_URL` (or `http://localhost:$PORT`). All paths below are relative to it.
Editor SPA: `GET /studio/*` (index.html fallback). `GET /` redirects to `/studio/`.

## Auth

- Login: `POST /api/v1/auth/login/basic/default` with `{"email","password"}` (email is lower-cased).
  - 200: `{"status":"success","message":"Login successful","payload":{"jwt":"...","exp":3600000}}`. `exp` is the lifetime in ms (legacy behaviour), not an epoch.
  - 400 bad credentials: `{"statusCode":400,"errorCode":"BP_0009","type":"InvalidCredentialsError","message":"Invalid credentials",...}`. Locked: `BP_0011`. Expired password: `BP_0010`.
- Every other protected route needs `Authorization: Bearer <jwt>`. JWT is HS256, audience `collaborators`, and is revoked when the user's `tokenVersion` changes.
- Missing or bad token: 401 with `{"statusCode":401,"errorCode":"BP_0041","type":"UnauthorizedError","message":"Unauthorized: Authorization header is missing" | "Unauthorized: Invalid authentication token" | ...}`.
- Error body for all errors: `{statusCode, errorCode, type, message, details, docs}`.
- Any valid collaborator token can use every studio/admin endpoint. There is no per-workspace RBAC (legacy `needPermissions`). Not built.

Set the UI's API base to `${EXTERNAL_URL}/api/v1/studio/{botId}` and send the Bearer header on each call. The UI can keep one token; on 401 it should re-login.

## Editor API (`/api/v1/studio/{botId}`)

Unknown or invalid bot id: 404 `Not Found: Invalid Bot ID`. Disabled bot: 404 `Bot is disabled` (except `/config`).
Writes on a bot with `"locked": true` in bot.config.json: 400 `Bad Request: Bot locked`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/flows` | | Array of FlowView (below) |
| POST | `/flows` | `{"flow": FlowView}` | 200, empty body. 400 if the name already exists |
| POST | `/flows/{name}` | `{"flow": FlowView}` | 200. If `flow.name` differs from `{name}` the flow is renamed (files moved, body ignored) |
| POST | `/flows/{name}/delete` | | 200 |
| GET | `/cms/types` | | `{"registered":[{id,count,title,hidden,schema:{json,ui,title,renderer}}],"unregistered":[]}` |
| GET | `/cms/elements/count` | | `{"count":N}` |
| GET | `/cms/{type}/elements/count` | | `{"count":N}` |
| POST | `/cms/elements` | `{count,from,searchTerm,ids}` (all optional) | Array of elements with `schema` |
| POST | `/cms/{type}/elements` | same | same |
| GET | `/cms/element/{id}` | | Element with `schema`. 404 text body if missing |
| POST | `/cms/{type}/element` | `{"formData":{...}}` | 200, body is the new id as plain text |
| POST | `/cms/{type}/element/{id}` | `{"formData":{...}}` | 200, body is the id |
| POST | `/cms/elements/bulk_delete` | `["id", ...]` | 200 |
| GET | `/actions` | | Array of `{name, scope:"global"|"bot", legacy, title, category, author, description, hidden, params:[{name,type,description,default,required}]}` |
| GET | `/config` | | bot.config.json |
| POST | `/config` | partial bot config | `{"status":"success","message":"Updated bot","payload":{"botId":...}}`. `id` is kept |
| GET | `/env` | | `{BOT_API_PATH, STUDIO_API_PATH, BOT_ID, BOT_NAME, BP_BASE_PATH, BOT_LOCKED, IS_BOT_MOUNTED, IS_PRO_ENABLED}` |
| GET | `/workspaceBotsIds` | | `[]` (as legacy) |
| GET | `/modules/skills` | | `[{"id":"choice","name":"module.basic-skills.choice","icon":"numbered-list","moduleName":"basic-skills"}]`. Name is the legacy translation key |
| POST | `/modules/basic-skills/skill/choice/generateFlow?isOneFlow=true\|false` | skill data `{contentId, invalidContentId, keywords, config:{nbMaxRetries, repeatChoicesOnInvalid, variableName}, randomId}` | `{"flow":{nodes,catchAll,version,name,location,startNode},"transitions":[...]}`. Ported from legacy choice.ts / choice_legacy.ts; legacy output matches the saved legacy sample. Other modules/skills: 404 `Invalid module name or flow name` |
| POST | `/media` | multipart, field `file` | `{"url":"/api/v1/bots/{botId}/media/{name}"}`. 400 with plain text for disallowed type, missing extension, or size over limit |
| POST | `/media/delete` | formData object (the element's formData) | 200. Removes every `image*` value and `items$*` image that points at `/media/` |
| GET | `/api/v1/bots/{botId}/media/{name}` | (public, no token) | file bytes, `Cache-Control: max-age=31556926`, type from extension. 404 `Not Found` |

### FlowView

```json
{
  "name": "main.flow.json",
  "location": "main.flow.json",
  "nodes": [ { ...node keys from flow.json..., "x": 100, "y": 200 } ],
  "links": [ ... from .ui.json ... ],
  "version": "...", "startNode": "entry", "catchAll": {...}, "skillData": {...}, "label": "...", "description": "..."
}
```

- `name` may contain `/` (e.g. `skills/choice-a1bdc2.flow.json`). The route is a catch-all, so the path is used verbatim (no encoding).
- Nodes keep the key order of flow.json. Positions `x`/`y` come from `.ui.json`. Unplaced nodes get legacy default positions.
- On save, `x`, `y`, `lastModified` are stripped from nodes and written to `.ui.json` as `{"nodes":[{"id","position":{x,y}}],"links":[...]}`. Files are written as `JSON.stringify(x, undefined, 2)` with no trailing newline, so an unchanged GET→POST leaves the files byte-identical (tested).
- Flow mutex is not built: no 423 response and no `currentMutex`.
- Before save, `flow.Validate` runs on the bot as it would be after the save. A failure returns 400 with the issue list and nothing is written.
- No flow mutex: legacy returns 423 when another editor holds the flow. Not built, so `currentMutex` is never sent and 423 is never returned.

### Element

```json
{ "id": "builtin_text-pSsHWg", "contentType": "builtin_text", "formData": {"text$en": "Hi"}, "createdOn": "...", "modifiedOn": "...", "schema": {"json":{...},"ui":{...},"title":"text","renderer":"builtin_text"} }
```

Content types registered: `builtin_text`, `builtin_single-choice`, `builtin_carousel`, `builtin_card`, `builtin_image`, `builtin_file` (schemas from legacy modules, embedded). Other types are rejected with 400.

## Code editor (`/api/v1/bots/{botId}/mod/code-editor`)

Actions and hooks, same request shapes as the legacy code-editor module:

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/files` | | `{"bot.actions":[EditableFile], "global.actions":[...], "bot.hooks":[...], "global.hooks":[...], "action_example":[], "hook_example":[]}` |
| GET | `/permissions` | | Map of the same keys with `{type,isGlobal,read,write}` |
| POST | `/readFile` | EditableFile | `{"fileContent":"..."}` |
| POST | `/exists` | EditableFile | `true`/`false` |
| POST | `/save` | EditableFile with `content` | 200 |
| POST | `/rename` | `{"file": EditableFile, "newName": "x.js"}` | 200 |
| POST | `/remove` | EditableFile | 200 |

EditableFile: `{name, type:"action_legacy"|"hook", location, botId?, hookType?, content?}`. Location is relative to `actions/` or `hooks/{hookType}/`. Global files use an empty `botId`. Example files and the `action_http` type are not served.

## Admin (`/api/v1/admin/workspace/bots`)

- `GET /` → `{"status":"success","message":"Retrieved bots","payload":{"bots":[bot.config.json, ...]}}`. (legacy also returns `workspace`; not sent.)
- `GET /{botId}/export` → `application/tar+gzip` attachment. Archive root holds the bot folder (`bot.config.json`, `flows/`, `actions/`, `content-elements/`, `hooks/`). JSON files have the bot id replaced by `BOT_ID_PLACEHOLDER`, as legacy. `models/` and `libraries/node_modules/` are excluded. `revisions.json` is not written.
- `POST /{botId}/import?overwrite=true|false` with `Content-Type: application/tar+gzip` and the raw archive. Without that content type: 400. Validates first (`flow.Load` + `flow.Validate`), then writes. Name becomes `"{name} ({botId})"` when the id differs from the name, as legacy.
- Errors use the same body shape.

## Not built (UI must not depend on these)

Content/CMS types beyond the six above, packages, NLU, QnA, hints, action servers, config of other modules, public-env.js, flow mutex (423), revisions, workspaces/RBAC, bot create/delete (only import/export), converse emulator routes (use `POST /api/v1/bots/{botId}/converse/{userId}/secured` with a Bearer token and `?include=state,suggestions,decision,nlu`).

## Converse (for the emulator)

`POST /api/v1/bots/{botId}/converse/{userId}/secured?include=state,...`, body `{"type":"text","text":"...","payload":{},"metadata":{}}`. Auth as above. Response and error handling are the engine's (`engine.Converse`): errors come back as `{statusCode, message, type, ...}` with the engine's status.
