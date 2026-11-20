# Spec: five additions to the tree mode (from colleague feedback)

Working note for the session that continues this branch. Remove this file before the branch is merged.
Status: step 1 (tree new) is in the code on this branch, tests pass, not yet reviewed. Steps 2 to 5 are not started.

```text
OVERVIEW
Five additions to the tree mode, in order. Nothing was run for this revision: I read parts of pmx-tree.js, treemerge.js and newman's run/index.js, and the only experiment is still the TypeScript 5 one behind step 4.

1. **tree new** adds a request (definition plus two empty script files) or a folder from the command line. It is addressed as "Folder / Name" or as a path inside the tree folder, which the shell can complete.
2. **Properties file**: pmx.config.json names the environments and the team default. pmx.local.json, personal and not used when git tracks it, holds one person's choice and own values. `tree env`, `tree env use`, `--env` and `--var` work with these, and the page saves to and reads from the same choice.
3. **tree run** sends one request and prints what the Postman app shows. It changes no file. `--first` or `runFirst` sends a login before it. Secret values show as `*****`. The page shows the answer too.
4. **tree ide** writes a jsconfig.json and type files, so `pm` and the rest complete in any editor.
5. **tree hook** installs a pre-commit hook that builds the JSON from what is being committed, so a commit of part of the work is fine. It also sets a merge rule and after-merge hooks, so the generated JSON never has a conflict.

Checks 14 to 18 are added, one per step; the README total goes from 56 to 61.

Three facts I checked shaped the design:
- newman runs several `folder` entries in collection order, not in the order given. `--first` therefore uses one newman run per request and carries the variables and cookies over.
- `build()` takes the folder to read as an argument. The hook can therefore build from a copy of the staged files.
- `treemerge install` already writes `.gitattributes` and the clone's git config, so the merge rule follows the same pattern.

Critic points taken: all except the six below.

Rejected, with the reason:
- `--literal` for tree new: a name with a slash that also starts with a folder name is rare, and the page can add it.
- `--from` (copy a request): it needs the request finder of step 3; it can follow as a small addition.
- `tree env show --newman`: `tree env` already lists the names that need a value, and the README gives the Jenkins line.
- `--allow-empty`: an empty value in pmx.local.json or `--var key=` does the same without a new option.
- Writing `.eslintrc.json` and `.prettierignore` into the tree: prettier reads its ignore file only from the folder it is started in, and eslint 9 does not read `.eslintrc`. `tree ide` prints the lines to add to the project's own files.
- A documented mode with the JSON not committed: not verified, and the merge rule plus hooks cover the conflict case.

Decisions that differ from the critics' wording:
- Own values in pmx.local.json are keyed by the variable's name, like the "current value" in Postman, not by the shell name.
- The hook always builds from the staged files, so the "changed but not staged" stop is gone.
- Set-Cookie values are starred in the terminal as well as in the page.

===== STEP 1: tree new: add a request or a folder from the command line =====
STEP 1 - tree new (pmx-tree.js, pmx.js HELP, README.md, test/tree.test.js)

Conventions for all five steps: `<pmx>` stands for `${pmx.SELF}`. Every path in a message goes through `rel()`; the tree folder is printed as `<tree>/`. Every refusal is `fail()` with exit 2 unless another code is named. No stack trace is ever printed. Line numbers below are those of the branch before this work.

Check numbering: the fuzz check stays last. This step inserts check 14 before it and renumbers the fuzz comment to 15 by hand. Tree mode count becomes 15 and the README total 57 (README lines 692 and 696). Each step also updates `HELP` in pmx-tree.js, the three tree lines of `HELP` in pmx.js (keep the text `tree adopt | build | verify | import`, which test line 278 matches) and the header comment of pmx-tree.js lines 10-16.

## Shared groundwork (done here, used by all steps)
- `parse(argv, sub)`: `run()` passes the subcommand. The old flags and value options stay global, so nothing that works today is refused.
- A table `ONLY` ties each new option to its commands. This step adds `method`, `url`, `parents`: `new`. Later steps add their own rows.
- A new option on another command is refused: `--url is not an option of "tree status". The options are listed by: <pmx> tree --help`.
- A set `MULTI` names value options that may be given several times and are collected into a list (empty in this step; step 2 adds `var`, step 3 adds `first`).
- `words(o, min, max, usage)`: the new commands read `o._` themselves and refuse extra words: `too many words after "tree <sub>": "<extra>". Put a name with spaces in quotes.`
- Line 1434 (first word becomes the collection) is not extended to any new command.

## Command lines
```
<pmx> tree new "<Folder / Sub / Name>" [--method <M>] [--url <address>] [--parents] [--tree <dir>]
<pmx> tree new <tree>/Orders/"Refund order"        (a path inside the tree folder: the shell can complete it)
<pmx> tree new --folder "<Folder / Sub>" [--parents] [--tree <dir>]
```
- `--folder` keeps its meaning as a value option; for `new` its value is the path of the folder to make.
- Give either one positional or `--folder`, never both and never neither.
- `--method`: default GET, must match `/^[A-Za-z]+$/`, stored in capitals.
- `--url`: default empty, stored as `url: { raw: <text> }` only. The page's `setUrl` fills host, path and query when the URL is next edited there, and newman accepts `raw` alone. `{{variables}}` are kept as typed.
- It works in both roles. Where the files are the source, the new files show as `A` and the parent as `M` in status. In a working copy they show as added and are packed like any edit.

## How the path is read (`newPath(ws, text)`)
1. **File form.** Turn `\` into `/`. If the text starts with `<tree>/` (the rel() form of the tree folder) or `path.resolve(text)` lies inside the tree folder: the part before the last `/` must be an existing directory of the tree that is a folder of the collection (it holds `folder.js`) or the top. That folder is the parent; the last part is the name. `--parents` has no meaning here. If the directory is not a folder of the collection: `<dir> is not a folder of the collection`.
2. **Name form.** Otherwise the text is cut at ` / ` (space, slash, space) and each part is trimmed. The last part is the new name; the parts before it are folders, matched by `node.name` from the definitions (not by directory name), level by level from the collection. One part means the top of the collection.
3. **Slash without spaces** (name form only). When a part holds `/` and the text before its first `/`, trimmed, is the name of a folder at that level, refuse: `"Orders/Refund order" has a / without spaces around it. For a request in the folder Orders write "Orders / Refund order". A name that really holds this slash can be added from the page.` Otherwise a plain `/` is part of the name, so `GET /orders` is one name.
   - Rejected from the critics: `--literal`. The case (a name with a slash that also starts with a folder name) is rare and the page covers it.

## Decisions
- **The files must be sound first.** `cmdNew` calls `describe(ws)` once; when `problems` is not empty it refuses before any write: `the files have problems. Fix them first: <pmx> tree status`. (A folder.js that cannot be read would otherwise hide a folder and lead to a second one.)
- **A missing parent folder is refused**, because a typing mistake would otherwise make a second folder. `--parents` makes the missing folders, each with its own `folder.js`, and prints one line per folder made.
- **A name already used by the same kind under the same parent is refused.** A request and a folder may share a name.
- **Script files are empty (0 bytes)**, as `addScript` writes them today, so the page and the command line behave the same. Known and accepted: where the files are the source, an empty file builds to `"exec": []`; Postman writes `[""]`, so the first `tree import` of a Postman export turns such a file into one line break.
- **A request that usually has a body gets the place for it.** For POST, PUT and PATCH the definition holds `header: [{ key: 'Content-Type', value: 'application/json' }]` and `body: { mode: 'raw', raw: '', options: { raw: { language: 'json' } } }`. Other methods get `header: []` and no body.
- Rejected from the critics: `--from "<request>"` (copy an existing request). It needs the request finder of step 3; it can follow as a small addition after that.

## Files written (all inside the tree folder through `inTree`/`writeText`)
- **Request**: `<dir>/<stem>.prerequest.js` (0 bytes), `<dir>/<stem>.test.js` (0 bytes), `<dir>/<stem>.request.js`, then the parent's definition with the new pointer added at the end of `$children`.
- **Request definition**: `defText('<A / B / Name>', { name, event: [prerequest entry, test entry], request: { method, header, url: { raw } [, body] }, response: [] })`. Key order: name, event, request, response. The `$script` values are bare file names.
- **Stem**: `stem = safe(name)`, with `_` added when it matches `RESERVED`. This is done in `addNode` for both kinds, so a folder called `con` becomes `con_/` too (also from the page). All three request files share one stem: choose the first of `stem`, `stem~2`, ... for which none of the three names is taken, compared without case. Do not call `freeName` three times.
- **Folder**: `<dir>/<stem>/folder.js` = `defText('<A / B>   (folder)', { name, item: { $children: [] } })`, then the parent with the pointer `<dirName>/`.
- **Order of writes**: scripts, the definition, the parent last. If a write throws, remove the files this call made (`fs.rmSync` through `inTree`) and throw again, so a failure leaves no unlisted file.

## Code
- `addNode(ws, parentId, kind, name, opt)` gains `opt = { method, url, scripts }`. Without `opt` it behaves as today apart from the `RESERVED` rule, so POST /api/add and check 11 (lines 615, 744) do not change. With `opt.scripts` it does the writes above. `addScript` is not called.
- New `cmdNew(o)`: `openTree`, one `describe`, `newPath`, walk the parts with `flat()`, make parents through `addNode(..., 'folder', ...)` when `--parents`, then one `addNode` call for the leaf.
- Reuse: `openTree`, `describe`, `flat`, `addNode`, `defText`, `safe`, `RESERVED`, `inTree`, `writeText`, `readDef`, `bodyOf`, `writeDef`.

## Output (stdout, exit 0)
```
new request: Orders / Refund order   (POST)
  <tree>/Orders/Refund_order.request.js      method, address, headers, body
  <tree>/Orders/Refund_order.prerequest.js   runs before the request (empty)
  <tree>/Orders/Refund_order.test.js         runs after the answer (empty)
  listed in <tree>/Orders/folder.js
next: edit the files, then: <pmx> tree build
```
- For a method without a body the first file line ends `method, address, headers`.
- For a folder: `new folder: Orders / EU` / `  <tree>/Orders/EU/folder.js` / `  listed in <tree>/Orders/folder.js`.
- With `--parents`, before these: `new folder: Orders   (it was missing)`.
- The `next:` line says `tree pack` in a working copy.

## Refusals
- No name: `say what to add: <pmx> tree new "Folder / Name"   or: <pmx> tree new --folder "Folder / Sub"`
- Both forms: `give a request path or --folder, not both`
- An empty part (`"Orders / "`, `" / x"`): `a name is missing in "<path>"`
- Missing parent: `there is no folder "Order" in the collection` (or `in "A / B"`) `. The folders there: Orders, Smoke. To make it too, add --parents`. With no folders: `There are no folders there.`
- Two parent folders with one name: `2 folders are called "Orders" there:\n  <ids>\nRename one of them, or name the folder by its path in <tree>/.`
- The path goes through a request (only when no folder of that name exists): `"Ping" is a request. A request cannot contain other requests.`
- Name taken: `"Orders" already has a request called "Refund order" (<tree>/Orders/Refund_order.request.js). Pick another name.` The same with `a folder`.
- `--method` or `--url` with `--folder`: `--method and --url are for a request, not for a folder`
- Bad method: `--method must be one word of letters, like GET or POST`
- A parent whose `item` is not a `$children` list: `addNode`'s own message is passed on.
- Nothing unpacked, several trees, links: `openTree`'s own messages.

Windows: names go through `safe()` and the reserved device names get `_`.

## Help and README
- HELP "Both": `tree new "<Folder / Name>"      add a request with its two empty script files (--folder "<path>" adds a folder)`.
- Options paragraph: `--method <M>`, `--url <address>`, `--parents` (also make folders that are missing).
- README: a row in the Commands table; a short part "Add a request from the command line" in "The files as the source" with the two ways to write the path, the three files and the pointer, and a note that all four files and the JSON go into one commit; the sentence about refused options also says that an option of another command is refused.

## Check 14 in test/tree.test.js ("tree new")
**Source role** (scratch dir, demo, git, `tree adopt`):
- `tree new "Orders / Refund order" --method post --url "{{baseUrl}}/refund"` exits 0 and the output names the three files.
- The definition has key order name, event, request, response; method POST; the raw URL; a `body` with mode raw; the Content-Type header. Both script files exist with 0 bytes.
- A GET request made the same way has no `body` and `header: []`.
- `Orders/folder.js` lists the pointer last.
- `tree verify` exits 1 before `tree build` and 0 after it. In the JSON the item is last in Orders and both `exec` are `[]`.
- `tree status` shows three `A` lines and one `M` line and no `?`.
- `tree import` of the built JSON followed by `tree verify` is quiet.
- File form: `tree new <tree>/Orders/"By file"` puts the request in Orders (also with backslashes).
- `tree new "Orders/Slash"` exits 2 with `has a / without spaces around it` and `git status --porcelain` is unchanged. `tree new "GET /orders"` works and makes one request at the top.
- `tree new --folder "Orders / EU"` makes folder.js and the pointer `EU/`.
- `tree new "Nowhere / X"` exits 2 with `there is no folder "Nowhere"` and `git status --porcelain` is unchanged. With `--parents` it works and prints `it was missing`.
- The same request again exits 2 with `already has a request called`.
- A request called `con` gets `con_.request.js`; `tree new --folder con` gets `con_/folder.js`.
- With `Orders/folder.js` made unreadable (broken text): exit 2 with `the files have problems` and nothing new on disk.
- Table of refusals: no name, both forms, `--method "GET x"`, `--url` on `tree status`, two positionals. None has `\n\s+at ` in the output.

**Working copy** (`tree unpack`): `tree new "Smoke / Version"`, then `tree pack` exits 0, the collection has the request with `exec: [""]` twice, and `tree finish` is not stopped by unlisted files.

===== STEP 2: The properties file: named environments, tree env, own choice and own values =====
STEP 2 - the properties file and tree env (pmx-tree.js, pmx-tree.ui.html, pmx.js, pmx.config.example.json, README.md, test/tree.test.js)

Conventions: as in step 1 (`<pmx>`, `rel()`, `fail()` exit 2, no stack trace). This step inserts check 15 before the fuzz check (fuzz becomes 16; tree mode count 16; README total 58) and updates HELP in both files and the header comment.

`ONLY` rows added: `env`: `test`, `run`, `ui`, `check`. `var`: `test`, `run`. `var` goes into `MULTI`. `--environment` keeps working everywhere it works today.

## Files
- **pmx.config.json** (committed, shared, never written by pmx) gains two keys:
  `"environments": { "dev": "env/dev.postman_environment.json", "staging": "env/staging.json" }` and `"environment": "dev"` (the team default; optional).
- **pmx.local.json** at the project root (personal, not committed):
  `{ "environment": "staging", "values": { "token": "abc", "orderId": "42" } }`.
  - `environment`: this person's choice. Written by `tree env use`, `tree env clear` and the page.
  - `values`: this person's own values, keyed by the name of the variable (like the "current value" in the Postman app). Written by hand. pmx keeps the key when it writes the file.
  - Written with `writeAtomic` as 2-space JSON plus a line break, keeping other keys. Refused when it is a link (lstat), on read and on write.
  - **When git tracks it, it is not used.** `config()` asks `git ls-files --error-unmatch -- pmx.local.json` (spawnSync, argument list; a failure or no git means not tracked). When tracked: `local` is `{}` and one line is printed on tree test, tree run, tree check --run, tree env and at the start of tree ui: `warning: git tracks pmx.local.json, so it is not used. Take it out: git rm --cached pmx.local.json   and add it to .gitignore`. `tree verify` (the Jenkins command) exits 1 with the same sentence.
- This is a new place pmx writes, next to the tree folder, the collection file and `.pmx/`. State it in the README.
- Names match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/`. `none` is reserved and means "no environment file".

## One reader for all tree code (replaces the reads at 979 and 1018)
`config()` returns `{ cfg, local, tracked }`. A missing file is `{}`. Messages:
- `pmx.config.json is not valid JSON: <parser message>` (the same for pmx.local.json)
- `pmx.config.json must hold one object` (the same for pmx.local.json)
- `"environments" in pmx.config.json must look like { "dev": "path/to/dev.postman_environment.json" }`
- `"<name>" cannot be the name of an environment in pmx.config.json. Use letters, digits, dot, dash and underscore. "none" is kept for "no environment".`
- `the environment "<name>" in pmx.config.json needs the path of a file`
- `"environment" in pmx.config.json is "<x>", but "environments" does not name it. It names: a, b`
- `"values" in pmx.local.json must look like { "token": "text" }`
- `pmx.local.json is a link. pmx does not read or write it through a link.`

`openTree` calls `config()` before `pmx.getCtx`, so a broken config in tree mode is a Problem. pmx.js gets `readConfig()` for `getCtx` and line 997; on bad JSON it calls `die('pmx.config.json is not valid JSON: ...')`, so the other pmx commands print no stack trace either.

## `envFile(file, name)`: the one guarded read of an environment file
Checks `insideCwd`, `reallyInsideCwd`, not `isLink`, is a file, parses as JSON, has a `values` list. Returns the object. Messages:
- `no such environment file here: <file>` (the wording test 4 matches), with ` (the environment "<name>" in pmx.config.json)` added when it has a name
- `<file> is a link. pmx does not read an environment through a link.`
- `<file> is not valid JSON: <message>`
- `<file> does not look like a Postman environment (no "values" list)`

## `pickEnv(o, conf)`: the one place that decides. First match wins
1. `--env <x>` or `--environment <x>`. Both spellings take both kinds: when `<x>` is a name under `environments` or `none`, it is that environment; otherwise it is a file path. `from: 'the --env option'`. Only `--env` is documented; `--environment` is "the old spelling, still works".
2. pmx.local.json `"environment"` (not when tracked): `from: 'your choice in pmx.local.json'`
3. pmx.config.json `"environment"`: `from: 'the team default in pmx.config.json'`
4. Otherwise null. newman then gets `newman.environment` from pmx.config.json exactly as today.

- Result: `{ file, name, from }`, `file` in `rel()` form with forward slashes. `none` gives `{ file: null, none: true }`: no environment file is used and `newman.environment` is dropped for that run.
- Refusals:
  - both options with different values: `give --env once. --environment is the old spelling of the same option`
  - neither a name nor a file: `"qa" is not an environment in pmx.config.json (it names: dev, staging) and there is no such file here` (or `it names none yet`)
  - `pmx.local.json picks the environment "qa", but pmx.config.json does not name it (any more). Pick another: <pmx> tree env use <name>`
- Used by `cmdTest`, `cmdCheck --run`, `cmdUi`/`serve` and, in step 3, `cmdRun`. `packOptions` carries the pick.
- Each of those commands prints one line when rule 1, 2 or 3 picked: `environment: dev (env/dev.json) - your choice in pmx.local.json` (for none: `environment: none - ...`). With rule 4 nothing is printed, so today's output is unchanged.

## Values that are not in the file
`readEnv(pick, conf, o)` returns `{ environment, envVar, filled, secrets }` for one run. The file on disk is never changed.
- **`${NAME}` from the shell.** Only in a file that pmx.config.json names under `environments` (never for a file given by path, never for a file found by scanning), and only when the whole value of an enabled variable is exactly `${NAME}`. It is replaced by `process.env.NAME`. One line per run names what was filled, never the value: `filled from this shell: API_TOKEN -> token (env/dev.json)`.
- **Own values.** Every entry of `values` in pmx.local.json, then every `--var key=value` of this command, is given to newman at the end of `options.envVar` (after `newman.envVar` of the config). newman lays these on top of the environment, whichever file is in use, also with `none`.
  - `--var` without `=` or with an empty key: `--var needs key=value, like --var orderId=42`.
- **A value that is missing stops the run.** A `${NAME}` variable with no such shell name and no own value for its key (pmx.local.json or `--var`) is refused, exit 2, before anything is sent: `the environment "dev" needs a value for token: ${API_TOKEN} is not set in this shell.\nSet it there, or give your own value in pmx.local.json: "values": { "token": "..." }   (an empty value counts: "token": "")`. Several are listed in one message.
  - Rejected from the critics: `--allow-empty`. An empty own value does the same without a new option.
- **`secrets`** is the list step 3 hides: enabled values with `type: "secret"` of the environment in use and every value of `values` in pmx.local.json.
- The `newman` block keeps `pmx.interp` as it is. Paths under `environments` are not replaced.
- `newmanRun` takes `o.env = { environment, envVar, none }` in place of reading `o.environment` itself; for a file path given the old way it calls `envFile`.

## Commands
```
<pmx> tree env                 list the named environments, say which is in use and what it still needs
<pmx> tree env use <name>      store your own choice in pmx.local.json ("none" = no environment file)
<pmx> tree env clear           remove your own choice; the team default applies again
--env <name or file>           on tree test, tree run, tree ui, tree check --run: for this one command
--var key=value                on tree test and tree run: one value for this one command (may be given again)
```
`tree env` needs no tree folder and does not call `openTree` or `getCtx`.

Output of `tree env` (exit 0):
```
environments in pmx.config.json:
  * staging   env/staging.json                    in use (your choice in pmx.local.json)
    dev       env/dev.postman_environment.json    team default
    prod      env/prod.json                       PROBLEM: no such environment file here
staging takes from this shell:
  token     ${API_TOKEN}   set
  tenant    ${TENANT}      MISSING (set it, or give "tenant" under "values" in pmx.local.json)
your own values (pmx.local.json): orderId, token
change it for yourself: <pmx> tree env use <name>     for one command: --env <name>
```
- Only names are printed, never a value.
- For a `${NAME}` variable whose entry is not `"type": "secret"`: `note: token comes from the shell but is not marked secret, so tree run shows it. Mark it with "type": "secret" to hide it.`
- When `none` is in use: `in use: no environment file (your choice in pmx.local.json)`.
- When none are named: `no environments are named in pmx.config.json yet. Add them like this:\n  "environments": { "dev": "path/to/dev.postman_environment.json" },\n  "environment": "dev"`. Then, when `environments()` finds files: `environment files found here:\n  <file>`. When `newman.environment` is set: `newman is given <file> (newman.environment in pmx.config.json).`
- A choice in pmx.local.json that is no longer named is a `PROBLEM:` line; the exit code stays 0.

`tree env use <name>` (function `useEnv(name)`, also called by the page):
- The name must be named in the config (or be `none`) and its file must pass `envFile`.
- Output: `in use from now on: staging (env/staging.json). Stored in pmx.local.json: it is yours alone, so Jenkins and your colleagues keep the team default.`
- When git tracks the file: nothing is written, exit 2, with the tracked warning above.
- Otherwise, when `git check-ignore -q pmx.local.json` exits 1: `note: add pmx.local.json to .gitignore, so that it is never committed`.

`tree env clear`: removes the key, and removes the file when nothing else is left. Output: `your own choice is removed. In use now: <name or "no environment">`.

Refusals: `tree env use` without a name gives `say which: <pmx> tree env use <name>   (the names: dev, staging)`. Any other word gives `tree env knows "use <name>" and "clear"`.

Rejected from the critics: `tree env show <name> --newman`. `tree env` already lists the names an environment needs, and the README gives the Jenkins line.

## The page (serve and ui.html): one choice, shared with the terminal
- `envList()`: the named environments first, then the files `environments()` finds that are not already named. Each entry is `{ file, name, keys, as, default }`. `as` is the configured name or null. `keys` are variable names with flags, read through a shared key reader. Values are never sent, and own values of pmx.local.json reach the page as names only (`ownKeys`).
- `name` stays the name inside the JSON file, so the assert at test line 579 holds. A named file that cannot be read is listed with `keys: []` and `problem: '<message>'`.
- **Reading**: `state()` and every run call `config()` and `pickEnv` again, so a `tree env use` in a terminal shows in the open page at its next refresh.
- **Writing**: POST /api/environment
  - with a named environment (or empty, meaning `none`... no: empty means "clear my choice"): calls `useEnv(name)` or the clear function, exactly as the command line does. The page shows `saved as your choice`. pmx.config.json is never written.
  - with a file that has no name: kept in memory for this page only (`sessionFile`), and it wins until a named one is picked. The page shows `for this page only`.
  - `--env` or `--environment` given to `tree ui` starts as such a session pick, shown as `for this page only (from --env)`.
  - when git tracks pmx.local.json: a named pick is kept for this page only, and the tracked warning is shown.
- `state()` adds `environmentAs` (the configured name or null), `environmentFrom` and `environmentSaved` (true or false). `lastRun.environment` stays the file path (test line 733) and gains `environmentAs`.
- A run from the page uses `readEnv` like the terminal. A missing value comes back as the plain message and nothing is sent.
- ui.html: the option label is `Environment: ` + (`e.as` or `e.name`), plus ` (team default)` when `e.default`. Next to the picker, as text: `saved as your choice` or `for this page only`. The results banner shows `environmentAs` when there is one.

Scope: `pmx test` (the fix-tests mode in pmx.js) is not taught the new keys; it keeps using `newman.environment`. Say so under "What this trial does not do yet".

## README
- Config key table: `environments`, `environment`, and add the missing `workDir`.
- A part "Which environment": the order above; pmx.local.json with `environment` and `values`; that it is not used when git tracks it; the `.gitignore` line in Setup step 4 (`.pmx/` and `pmx.local.json`); `${NAME}` (named files only, whole value only, the `filled from this shell` line, the stop when a value is missing).
- **Jenkins**, stated plainly: plain newman does not know the named environments and does not replace `${NAME}`. Two ways that work: `<pmx> tree verify && <pmx> tree test --env ci` (the reporters of the `newman` block still apply), or newman called directly with `-e <file> --env-var "token=$API_TOKEN"` for each name that `tree env` lists.
- pmx.config.example.json gets the two keys.
- "What leaves your machine": pmx.local.json is written at the project root; a named environment file can take values from the shell, only for a whole value `${NAME}`, and each run names what it took.

## Check 15 ("the properties file")
**Setup**: scratch dir with the demo, git, `tree adopt`, the mock API running. `env/dev.json` and `env/staging.postman_environment.json` set `baseUrl` to the mock and to a dead port. Config has `environments`, `environment: "staging"` and a newman timeout. `env/dev.json` is chosen on purpose: its name does not match the scan pattern.
- **tree env**: lists both and marks staging as the team default. `tree env use dev` writes pmx.local.json exactly `{ "environment": "dev" }` and prints the `.gitignore` note. `tree env` then marks dev as in use.
- **tree test**: prints `environment: dev` and reaches the mock. `tree test --env staging` prints staging and fails to connect, exit 1. `--env env/dev.json` and `--environment dev` both work.
- **tree env clear**: afterwards the team default is in use.
- **Tracked**: `git add -f pmx.local.json` (holding dev). `tree test` prints `so it is not used` and uses the team default; `tree env use dev` exits 2; `tree verify` exits 1 with the sentence. After `git rm --cached` all is as before.
- **Jenkins case**: pmx.config.json is byte for byte unchanged after every command.
- **`${NAME}`**: a value `${PMX_T_TOKEN}` in dev.json with the variable set reaches a script (assert through a test in the collection) and the output has `filled from this shell: PMX_T_TOKEN -> token`. With it unset: exit 2 with `needs a value for token` and the mock got no request. With `"values": { "token": "x" }` in pmx.local.json, or `--var token=x`, it runs. The same `${...}` text in a file given by path is sent as written. A value `a${PMX_T_TOKEN}` (not the whole value) is sent as written.
- **Own values**: `--var orderId=42` reaches a script; `--var orderId` exits 2.
- **tree env output**: shows `MISSING` for the unset name, the not-secret note, and no value of any file or of pmx.local.json.
- **Refusals** (exit 2, no stack trace): `--env qa`; `--env dev --environment staging`; `env use qa`; a named file that is missing; a named file that is a link; pmx.config.json that is not JSON (tried with `tree status` and `tree env`); pmx.local.json that names something unknown (tried with `tree test`); `--env` on `tree status`; `--var` on `tree status`.
- **Page**: start `tree ui --no-open`. `/api/state` has `environment === 'env/dev.json'`, `environmentAs === 'dev'`, `environmentSaved === true`; the list holds key names; no value of the file or of pmx.local.json appears anywhere in the state. POST /api/environment with staging rewrites pmx.local.json to staging. Then `tree env use dev` in a child process, and the next `/api/state` says dev. POST with an unnamed file leaves pmx.local.json unchanged and `environmentSaved === false`.

===== STEP 3: tree run: send one request and show the answer, in the terminal and in the page =====
STEP 3 - tree run, and the response in the page (pmx-tree.js, pmx-tree.ui.html, pmx.js, README.md, test/tree.test.js, test/tree-ui.browser.js)

Conventions: as in step 1. This step inserts check 16 before the fuzz check (fuzz becomes 17; tree mode count 17; README total 59) and updates HELP in both files and the header comment.

`ONLY` rows added: `full`, `sent`, `body`, `first`: `run`. `first` goes into `MULTI`. New flags: `full`, `sent`, `body`. New value option: `first`.

## Command line
```
<pmx> tree run <request> [--env <name or file>] [--var key=value] [--first <request>] [--sent] [--full] [--body] [--tree <dir>]
```
`<request>` is exactly one word, resolved by `whichRequest(ws, text)`. The first stage that finds something decides:
1. **A file.** Turn `\` into `/`. If `path.resolve(text)` lies inside the tree folder, take its path inside the tree; otherwise try the text itself as a path inside the tree. Only an existing file counts: a `.request.js` file means that request, and a script file means the request that lists it (so the file open in the editor can be given). `folder.js`, `collection.js` or a script of a folder is refused with the folder message below. A directory is not a hit; the search goes on.
2. **The full path.** Requests whose `node.path.join(' / ')` equals the text. Both sides are compared after trimming and after turning any spacing around `/` into ` / `.
3. **The name.** Requests whose `node.name` equals the text.

Refusals:
- None given: `say which request: <pmx> tree run "Folder / Name"   or: <pmx> tree run <file of the request>`
- Only when stages 2 and 3 found no request and a folder has that path or name (or a folder file was given): `that is a folder, and tree run sends one request. To run a folder: <pmx> tree test --folder "<name>"`
- No hit: `no request is called "X"`, followed when there are near names (the name contains the text, without case, at most 5) by `Did you mean:\n  Orders / Open orders   (<tree>/Orders/Open_orders.request.js)`
- Several hits: `2 requests are called "Ping":\n  Smoke / Ping   (<file>)\n  Other / Ping   (<file>)\nName it with its folders ("Smoke / Ping") or by its file.` If the full paths are equal too, the last sentence is `Name it by its file.`

## What it does
- **It changes no file.** The collection is built in memory: `packTree` with `dry: true` plus the options that `packOptions` makes for `--force` and `--allow-test-removal`. The guards for a removed test and for a JSON that was edited directly protect what gets committed, so they do not apply to a trial send. Only what makes the collection unusable stops the run (a script that does not parse, a broken definition): exit 2 with the `TREE BUILD REFUSED` list and nothing is sent. `tree build`, `tree test` and the hook keep writing the JSON as before. Help and README say that tree run changes no file.
- Then newman runs the whole collection with `options.folder` set to that one item. Collection and folder scripts and auth apply.
- **Requests to send first** (a login). `--first "<request>"` (may be given again) and the config key `"runFirst": ["Auth / Login"]` in pmx.config.json name requests that are sent before the one named, in the order given; `--first` replaces the config list for that command. Each is resolved by `whichRequest`. The named request itself is left out of the list.
  - newman runs several folders in collection order, not in the order given (checked in newman's run/index.js). So each request gets its own `newmanRun`, and the next run is given what the one before left: `summary.environment`, `summary.globals`, the collection variables (`summary.collection.variables`, put into the next run's collection), and one shared cookie jar (`options.cookieJar`, made once by `jar()` of `postman-request` resolved from newman's folder; when it cannot be resolved, cookies are not carried and one note line says so). The implementer checks that collection variables come through this way; if they do not, the README says so.
  - One line per first request: `first: Auth / Login   200 OK   35 ms` (or `first: Auth / Login   no answer: <text>`).
  - When a first request gets no answer, the named request is not sent: `RESULT: FAIL - "Auth / Login" got no answer, so the request was not sent`, exit 1. Failing tests of a first request are printed as `first: ... 1 test failed` and do not stop the run.
  - Bad config: `"runFirst" in pmx.config.json must be a list of request names`.
  - README: a variable that a script sets lives for this one command; the next `tree run` starts from the files again, which is why the login is sent each time.
- The environment comes from `pickEnv`/`readEnv` of step 2, with the `environment:` line and the stop for a missing value.

## `newmanRun` changes, all behind `o.capture`
- **Forced for a single-request run, over the config**: `reporters: []`, `iterationCount: 1`, `bail: false`, and every `export*` key removed, so a run of one request never writes a file.
- **Wrong position guard**: if `o.only` is given and `idAt.get(o.only)` is undefined, fail with `that request is not in the built collection`. This closes today's quiet "the whole collection runs" hole.
- **Carry**: `o.carry` in (environment, globals, collection variables, cookie jar) and the same out in the result.
- **Listeners**: `beforeRequest`, `request`, `console`, `script` and `exception` next to `assertion`. Each body is wrapped in try/catch, because a handler must not throw. Entries are grouped by `cursor.ref`.
- **Own requests only**: an entry is the request itself only when `cursor.scriptId` is not set (the `own` test of pmx.js:660). Calls made by `pm.sendRequest` are only counted, as `sub`.
- **Exchange**: `{ pos, iteration, method, url, sent: { headers, body }, error, status: { code, text }, time, bodyBytes, headerBytes, headers: [{ key, value }], body, raw, redirects: [{ code, url }], console: [{ level, text }], scriptErrors: [{ listen, ownerPos, text }], sub }`. `url` is `request.url.toString()` from `beforeRequest`; `sent` comes from the `request` event; `redirects` come from `history.execution.data` when it has more than one entry; `raw` (the Buffer) is kept only for `--body`.
- **body**: `{ kind: 'empty' | 'json' | 'text' | 'binary', type: <content-type>, text, bytes }`.
  - `binary`: the Buffer has a NUL byte, or is not valid UTF-8 (`Buffer.from(buf.toString('utf8')).equals(buf)` is false). No text is kept.
  - `json`: the whole text passes `JSON.parse`. It is laid out by a small `tidy(text)` that puts line breaks and 2-space indents between tokens and keeps every number and string as written. Do not use `JSON.stringify(JSON.parse())`.
  - `text`: everything else.
- **Console**: lines use `pmx.fmtArg` (export it from pmx.js). Lines matching `is deprecated. Use ` are dropped.
- **Script errors**: the `script` event with an error gives `listen` and the owner (`event.parent()`). `testTree` maps the owner to the script file through `positions()`. This newman version gives no line number, so none is promised.
- `newmanRun` resolves `{ assertions, errors, requests, exchanges, notes, carry }`. The old fields are unchanged, so `cmdCheck` and check 11 keep working. `testTree` gives each exchange `id` and `path` through `byPos`, and takes `o.capture`, `o.noWrite` (the in-memory build) and `o.first`.

## What is hidden, and what is made safe to print
Order for every piece of text from the wire or from a script: **hide first, then make control characters visible, then cut.**
- **Hide list** (`hideList`): the `secrets` of step 2's `readEnv` (enabled `type: "secret"` values of the environment in use, and every own value of pmx.local.json); the same for `newman.environment` when no file is picked and for `newman.globals`; and every `${NAME}` value that `pmx.interp` fills inside `envVar` and `globalVar` of the `newman` block (run the same regular expression over `cfg.newman` to learn which). Values shorter than 4 characters are left out. A `${NAME}` value in an environment file that is not marked secret is shown (hosts and tenant names stay readable; `tree env` gives the hint).
- For each value also hide `encodeURIComponent(v)` and `JSON.stringify(v).slice(1, -1)`. Each hit becomes `*****`.
- The scheme and host of the address line are never starred: the origin is printed as it is and the list is applied to the rest.
- **Cookies**: the value of every `set-cookie` answer header is shown as `<cookie name>=*****` plus its attributes, in the terminal and in the page. With `--sent`, the values of `Authorization`, `Proxy-Authorization` and `Cookie` are shown as the scheme word (when there is one) plus `*****`.
- When something was replaced, one line: `note: secret values are shown as *****`.
- **`shown(text)`**: every C0 and C1 control character except line break and tab (and CR before LF) becomes a visible form such as `\x1b`. Used in `cmdRun` for status text, headers, body, console and error text, and for newman error text in `cmdTest`.

## Terminal output of `cmdRun`
After the `environment:` line and any `first:` lines:
```
Smoke / Ping
GET http://127.0.0.1:5123/health
200 OK   12 ms   11 B

answer headers
  content-type: application/json
  date: ...

answer body (json)
{
  "ok": true
}

console
  log    hello
  warn   careful

tests
  pass   status is 200
  FAIL   body says ok
         edit -> <tree>/Smoke/Ping.test.js:4
         expected false to be true
  skip   later

RESULT: FAIL - 1 of 3 tests failed
```
- Size is the body size, in B, KB or MB (1024).
- Redirects: one line per hop before the status line, `301 -> http://...`.
- `--sent` adds, after the address line, `sent headers` and `sent body`. The terminal only; the page never gets these.
- Sections with nothing in them are left out. An empty body prints `answer body: empty`.
- Binary: `answer body: 20480 bytes that are not text (image/png). Not shown.`
- **Cut** (`cutBody(text, isTerminal, full)`, exported for the test): when stdout is a terminal and `--full` is not given, the body is cut after 200 lines or 20,000 characters, followed by `... cut after 200 lines of <n>. To see all of it: --full` and the status line once more. When the output goes to a file or a pipe, nothing is cut.
- **`--body`**: stdout gets only the answer body as received (text kinds with the hide list applied, binary as its bytes; control characters are made visible only when stdout is a terminal); everything else goes to stderr. So `<pmx> tree run Ping --body | jq .` works.
- `pm.sendRequest` calls: `(a script sent 2 more requests of its own; they are not shown)`.
- Could not connect:
```
GET http://127.0.0.1:1/health
no answer: connect ECONNREFUSED 127.0.0.1:1
The scripts ran all the same, without an answer. What they report below mostly says only that.
```
- Script error: under `errors`, `  <tree>/Smoke/Ping.test.js: TypeError: x is not a function`. Without a file: `  test script: ...`.
- Result lines:
  - `RESULT: PASS - <n> tests, 0 failed`
  - `RESULT: SENT - 500 Internal Server Error. It has no tests.` (the status as answered; exit 0)
  - `RESULT: FAIL - <f> of <n> tests failed`, with `, <e> error(s)` when there are any
  - `RESULT: FAIL - no answer`
  - `RESULT: FAIL - newman ran no request`
- Exit codes: 0 when an answer came, no test failed and no script error happened; 1 otherwise; 2 when refused. An HTTP status of 404 or 500 alone is not a failure, as in the Postman app: the tests decide.
- newman not installed: `loadNewman`'s message, exit 2.

## The page: what reaches it (stated plainly, also in the README)
- **Sent to the page for each request of the last run**: method, the address that was called (variables filled in), status, time, sizes, redirects, answer headers (cookies starred), answer body (text or laid-out JSON, at most 200,000 characters, with a `cut` flag and the full length), console lines (at most 200 lines of 2,000 characters), `sub`, and `error`. Everything after the hide list and `shown()`.
- **Never sent**: the headers and body that were sent, cookie values, and any environment value as such.
- **The rule that changes**: the page still gets only names from environment files. A run result is different: the address and the answer can hold values, such as a base URL. This is the one deliberate exception.
- **Storage**: a closure variable `responses` (Map of node id to exchange, first iteration only) next to `lastRun`. Replaced together with `lastRun`, only by a run that sent a request. Memory only, never written to disk.
- **Total limit**: 5,000,000 body characters per run. Later bodies are stored empty with `dropped: true`, and the page says: `not kept, the run was large. Run this request alone to see it.`
- **`lastRun`** (which rides on every /api/state) gains only small fields: `onlyId` (node id or null), `responses` (the list of ids that have one), `first` (the `first:` lines) and `notes`.
- **New route** `GET /api/response?id=<node id>` returns `{ at, response }` or `{ response: null }`. The id is checked against the Map only. It needs the key header like every route.
- **POST /api/test** is unchanged in shape and keeps building as `tree test` does (the page's run writes the JSON as today). It calls `testTree` with `capture: true`; for one request it also sends the `runFirst` requests first.

ui.html:
- `viewRun`: when `lastRun.onlyId` is in `lastRun.responses`, fetch `/api/response` (guarded by `S.token`) and draw a card "Answer" above the test groups: the method and address line, the status, time and size line, a headers table, the body in a `pre` element, the console lines.
- A new tab "Answer" in a request's tab strip (the labels array at 551, the dispatch in `renderTab`) is shown when `S.st.lastRun.responses` includes the node. It draws the same card through a shared `drawResponse(el, r)`. This covers runs of a folder or of everything.
- Everything is built with `h()` and text nodes. New classes go in the nonce style block. No style attributes, no innerHTML, no image or HTML preview, no change to the CSP.
- JSON arrives laid out from the server; the page does not parse it again. Binary and cut bodies show the same plain sentences as the terminal.
- The card is drawn from fetched state held in `S` (`S.response = { id, at, data }`), so the window focus redraw keeps it.

## Help and README
- HELP "Both": `tree run <request>              send this one request and show the answer: status, headers, body, console, tests (changes no file)`.
- Options: `--first <request>` (run: send this one before it, a login say), `--sent` (run: also show what was sent), `--full` (run: do not cut a long body), `--body` (run: only the body on standard output).
- README:
  - a Commands row;
  - a part "Run one request": the three ways to name it, that no file is changed, `--first` and `runFirst` for a login, `--body` with jq, what is starred;
  - `runFirst` in the config key table and in pmx.config.example.json;
  - the page table row for "Run this";
  - line 625 now points to `tree run` for names that are not the only one;
  - "What leaves your machine": `A run sends requests to the addresses that the collection, the environment in use and pmx.config.json give, follows the redirects the server answers with, and sends whatever the scripts send themselves (pm.sendRequest). pmx adds no address of its own.` The answer is shown in the terminal and in the page, kept in memory only and never written to a file; and the list of what the page gets.

## Tests
**Check 16 ("tree run")**. Setup: scratch dir, demo, `tree adopt`, mock running, `console.log('hello from ping')` added to `Smoke/Ping.test.js`, `tree build`, commit.
- **All three ways to name it**: `tree run "Smoke / Ping"`, `tree run Ping`, `tree run <tree>/Smoke/Ping.test.js` (also with backslashes) each exit 0. The output has `GET http://127.0.0.1:<PORT>/health`, `200 OK`, `content-type: application/json`, the body laid out (`{\n  "ok": true\n}`), `log    hello from ping`, `pass   ` with the test name, and `RESULT: PASS`.
- **No file changes**: edit a script, `tree run`; the collection JSON is byte for byte the same and `git status --porcelain` shows only the edited script. With a test removed from a script, and with the JSON edited by hand, `tree run` still sends (no `TREE BUILD REFUSED`).
- **Inherited scripts**: a collection test script's `pm.test` shows under tests.
- **A failing test**: `tree run "Orders / Open orders"` exits 1 with `FAIL`, `edit -> .../Open_orders.test.js:<line>` and the message.
- **No tests**: a request without tests whose answer is 500 (tiny server) prints `RESULT: SENT - 500` and exits 0.
- **`--first`**: a request "Auth / Login" whose test script does `pm.environment.set('tok', 'abc123')`, and a request that sends `{{tok}}` in a header to a tiny server that echoes headers. Without `--first` the echo holds `{{tok}}`; with `--first "Auth / Login"` it holds `abc123` and the output has `first: Auth / Login   200`. The same through `runFirst` in the config. A first request on a dead port gives exit 1 and `was not sent`.
- **`--sent`**: prints `X-Demo-Client`, which the collection script sets.
- **`--body`**: stdout is exactly the body bytes of the mock; stderr has `RESULT:`.
- **Could not connect**: base URL on a dead port, exit 1 with `no answer:`.
- **Hidden values**: a secret-typed value in the query string shows as `*****` and the real value is nowhere in the output, also when it needs URL encoding. A token given through `newman.envVar` as `${PMX_T_TOKEN}` is nowhere in the output with `--sent`. A `${NAME}` host that is not marked secret is shown. An answer `Set-Cookie: sid=abc123` prints `sid=*****`.
- **Control characters**: the tiny server answers `\u001b[2J`; the output holds `\x1b[2J` as text and no byte 0x1B.
- **Two requests called Ping**: exit 2 with `2 requests are called "Ping"`; the full path works.
- **A request and a folder with one name** ("Smoke" as a request at the top): `tree run Smoke` sends the request.
- **Other refusals**: `tree run Orders` gives `that is a folder`; `tree run Nowhere`; no word; two words; `--full` on `tree test`.
- **A build that cannot be used** (a script with a syntax error): exit 2, `TREE BUILD REFUSED`, and no `no answer` line with the request pointed at a dead port.
- **Body kinds**: the tiny server answers `/bin` with bytes that hold a NUL and `/big` with 3 MB of text; a request to each is added with `tree new --url`. `/bin` prints `not text`. `/big` piped prints all of it. `cutBody` is tested in process: as a terminal it cuts after 200 lines and names `--full`; with `full` it does not.

**Check 11 additions**, kept under the same `ok`:
- After POST /api/test `{ id: 'Smoke/Ping.request.js' }`: `run.onlyId`, and `run.responses` deep equals `['Smoke/Ping.request.js']`.
- GET /api/response gives code 200, a URL that ends in `/health`, and a body of kind `json`.
- The whole state text does not contain the body, and `/api/response` has no `sent` key.
- A mock answer with `Set-Cookie: sid=abc123`: `abc123` is not in `/api/response`.
- An unknown id gives `response: null`. The route needs the key header.

**test/tree-ui.browser.js** (run by hand): click `#nodehead button:has-text("Run this")` on Ping, wait for `main .card:has-text("Answer")`, assert it holds `200` and `"ok": true` as text, the `Answer` tab appears, and `problems` stays empty. A request whose answer is the text `<img src=x onerror=...>` (tiny server in the test) puts no `img` element on the page.

===== STEP 4: tree ide: open the folder as a normal JavaScript project =====
STEP 4 - tree ide (pmx-tree.js, pmx.js HELP, README.md, test/tree.test.js)

Conventions: as in step 1. This step inserts check 17 before the fuzz check (fuzz becomes 18; tree mode count 18; README total 60) and updates HELP in both files and the header comment.

`ONLY` row added: `remove`: `ide` (step 5 adds `hook`). New flag: `remove`.

## Command line
```
<pmx> tree ide [--tree <dir>]
<pmx> tree ide --remove [--tree <dir>]
```

## The four files, all inside the tree folder
Only the tree folder becomes a JavaScript project; a `jsconfig.json` or `tsconfig.json` at the project root is not touched. Each file starts with a mark line that says pmx wrote it.
- `<tree>/jsconfig.json`. First line: `// written by "pmx tree ide". Run it again to renew this file; remove it with: tree ide --remove` (editors read this file with comments). Then:
```
{ "compilerOptions": { "checkJs": false, "target": "ES2022", "lib": ["ES2022"], "module": "commonjs", "moduleDetection": "legacy", "types": [], "skipLibCheck": true, "noEmit": true, "baseUrl": ".", "paths": { "postman-collection": ["./.pmx-ide/postman-collection.d.ts"] } },
  "include": ["**/*.js", ".pmx-ide/*.d.ts"] }
```
- `<tree>/.pmx-ide/postman-sandbox.d.ts`: a copy of `postman-sandbox/types/sandbox/test.d.ts` with the line `/// <reference types="node" />` removed and the first line `// copied by "pmx tree ide" from postman-sandbox <version> (Apache-2.0). Do not edit.` The test file is used for all scripts: it is the larger set, so `pm.response` also completes in a pre-request script, and loading both type files would declare every name twice.
- `<tree>/.pmx-ide/postman-collection.d.ts`: the same kind of copy of `postman-collection/types/index.d.ts` (about 108 KB), with the same kind of first line. The sandbox types point at it for `pm.response`, `pm.request` and `pm.environment`.
- `<tree>/.pmx-ide/globals.d.ts`: first line `// written by "pmx tree ide". Do not edit.` It declares `console`, `require`, `module` (`{ exports: any }`), `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`.

Why copies and not paths into node_modules: the folder can be committed and then works for every colleague and in a clone without newman.

Finding the types: for each of the current folder and the tool's folder, `require.resolve('newman/package.json', { paths })`, then `postman-sandbox/package.json` and `postman-collection/package.json` resolved from newman's folder, with a direct resolve as fallback. This only reads.

All writes go through `inTree`/`writeText`: atomic, no links.

## Tried with TypeScript 5 in a scratch folder (the only experiment behind this spec)
- With this jsconfig and these copies, `pm.response.code` is known and `pm.nope` is flagged once a file opts in with `// @ts-check`.
- With `checkJs: false` the checker reports nothing for a script with a top-level `return` and `await`, for two scripts that both declare `const x`, or for the definition files.
- Completion still comes from the same types.

## "A file that nothing lists"
- New predicate `helper(file)`: true only for the four exact paths pmx writes, at the top of the tree: `jsconfig.json`, `.pmx-ide/postman-sandbox.d.ts`, `.pmx-ide/postman-collection.d.ts`, `.pmx-ide/globals.d.ts`. Any other file under `.pmx-ide/`, and a `jsconfig.json` deeper in the tree, is reported as unlisted like today. So check 13 (a committed file that nothing lists fails verify) keeps holding.
- `treeFiles()` and `headFiles()` both leave the four out. That keeps verify, status, finish, unpack, import, pack and the page quiet, and keeps committed helper files out of "removed".
- `split()`'s `claim` is **not** changed (a working copy unpacked by an older version must keep its file names). `freeName` treats `jsconfig.json` at the top as taken, so a folder of that name added later gets `jsconfig.json~2`. A name that starts with a dot can never come from `safe()`.
- Consequences, stated in the README: `tree finish` and `tree unpack --force` remove the helper files with the folder without a word (run `tree ide` again). `tree adopt` needs an empty folder, so `tree ide` comes after it.

## Renew and remove: only what pmx wrote
- A renewed write and `--remove` touch a file only when its first line is its pmx mark line.
- `tree ide` again: each of the four is rewritten when it has the mark. One without the mark is a refusal (below) and nothing is written.
- `--remove`: removes each of the four that has its mark, then removes `.pmx-ide/` with rmdir only when it is empty. Output: `removed: <file>` per file; for what stays: `left as it is (pmx did not write it): <file>`; when nothing of it is there: `there is nothing of tree ide in <tree>/`. Exit 0.

## Output (exit 0)
```
written: <tree>/jsconfig.json
written: <tree>/.pmx-ide/   (types of postman-sandbox 4.7.1: pm, pm.test, pm.response and the rest complete in your editor)
open <tree>/ in your editor like any JavaScript project. Commit these files, so that everybody gets them.
If this project has its own tools, tell them to leave the folder alone:
  prettier   add the line <tree>/ to .prettierignore
  eslint     add "<tree>/**" to "ignores" (or the line <tree>/ to .eslintignore)
  jest       testPathIgnorePatterns: ["<tree>/"]      vitest: exclude: ["<tree>/**"]
```
- In a working copy the third line ends: `They go away with the folder at tree finish.` and the tool lines are left out (the folder is not committed there).
- Rejected from the critics: writing `.eslintrc.json` and `.prettierignore` into the tree folder. prettier reads its ignore file only from the folder it is started in, and eslint 9 does not read `.eslintrc` files, so those two files would not do what they promise. The settings live in files of the host project, which pmx must not write; the lines above are printed and are in the README.
- Types not found (newman not installed): jsconfig.json and globals.d.ts are still written. postman-sandbox.d.ts then holds, after its mark line, only `declare var pm: any; declare var postman: any; declare var tests: any; declare var responseBody: any;` and postman-collection.d.ts is not written. Message: `the Postman type files were not found (they come with newman), so pm is known but does not complete. Install newman once (npm i -D newman) and run this again.` Exit 0.

## Refusals
- jsconfig.json is there without the mark: `<tree>/jsconfig.json is there and pmx did not write it. Move it away first, or keep it and add ".pmx-ide/*.d.ts" to its "include".` Nothing is written.
- `<tree>/jsconfig.json` is a directory (a folder of the collection has that name): `<tree>/jsconfig.json is a folder of the collection, so the editor file cannot be written there`. Nothing is written.
- One of the three type files is there without its mark: `<file> is there and pmx did not write it. Move it away first.` Nothing is written.
- `.pmx-ide` or one of the files is a link: `inTree`'s refusal.
- No tree: `openTree`'s messages.
- `--remove` on another command than ide or hook: the `ONLY` refusal.

## Help and README
- HELP "Both": `tree ide                        write a jsconfig.json and type files, so that pm and the rest complete in any editor (--remove takes them out)`.
- README, a part "Open the folder in your editor":
  - what is written and what completes;
  - checking is off (`checkJs: false`), because scripts are function bodies; a file can opt in with `// @ts-check`;
  - the lines for prettier, eslint, jest and vitest, with the reason (these tools would treat the scripts as code of the project: `pm` not defined, files laid out again, `*.test.js` collected);
  - the two consequences above (finish and unpack --force; after adopt).
- A row in the Commands table. "What leaves your machine" gains nothing beyond "writes inside the tree folder".

## Check 17 ("tree ide")
**Source role** (git, adopt, commit):
- `tree ide` exits 0. jsconfig.json starts with the mark and, after the first line, parses with the expected `include` and `paths`.
- `.pmx-ide/postman-sandbox.d.ts` starts with its mark, contains `declare var pm: Postman` and no `reference types="node"`. postman-collection.d.ts and globals.d.ts exist with their marks.
- The output names prettier, eslint and jest.
- `tree verify` exits 0 and `tree status` has no `?` line. `tree build` exits 0 and the JSON is unchanged.
- After `git add` and commit: `tree status` is still clean and `tree verify` still exits 0.
- A file `Smoke/jsconfig.json` (deeper) makes verify exit 1 and is named.
- A file `.pmx-ide/extra.js` makes verify exit 1 and is named; it survives `tree ide --remove`, the folder `.pmx-ide/` stays, and the output says `left as it is`.
- A second `tree ide` exits 0.
- `tree ide --remove` (without the extra file) removes all four and the folder, and verify still exits 0. A second `--remove` says `there is nothing of tree ide`.
- A foreign jsconfig.json (no mark) gives exit 2 with `pmx did not write it`, and the file is byte for byte unchanged. The same for a foreign `.pmx-ide/globals.d.ts`.
- A directory at `<tree>/jsconfig.json` gives exit 2 with `is a folder of the collection`.
- A symlink at `.pmx-ide` gives exit 2 with nothing written outside.
- `tree new --folder jsconfig.json` (after `tree ide`) makes `jsconfig.json~2/`.
- `--remove` on `tree status` is refused.

**Working copy**: `tree ide`, then `tree status` shows no `?`, and `tree finish` exits 0 and the folder is gone.

**Types not found**: run with a copy of pmx.js, pmx-tree.js, treemerge.js and the page in a folder with no node_modules, cwd a scratch dir without newman. Exit 0, the message `were not found`, and a jsconfig.json is written.

===== STEP 5: tree hook: keep the generated JSON in step at commit and after a merge; final README pass =====
STEP 5 - tree hook, and the final README pass (pmx-tree.js, pmx.js HELP, README.md, test/tree.test.js)

Conventions: as in step 1. This step inserts check 18 before the fuzz check (fuzz becomes 19; tree mode count 19; README total 61 = 23 + 19 + 19) and updates HELP in both files and the header comment.

`ONLY`: `remove` now also for `hook`.

## Command line
```
<pmx> tree hook              set up this clone: a pre-commit hook, two after-merge hooks and a merge rule for the JSON
<pmx> tree hook --remove     take them out again
<pmx> tree hook run          what the pre-commit hook calls
<pmx> tree hook after        what the post-merge and post-rewrite hooks call (also fine to run by hand)
```

## What `tree hook` sets up
1. **Three hook files** in the hooks folder of this clone: `pre-commit`, `post-merge`, `post-rewrite`.
2. **A merge rule that never reports a conflict in the generated JSON** (the file is built again anyway):
   - in this clone's git config, as `treemerge install` does it (treemerge.js 813-817): `merge.pmx-generated.name` = `generated by pmx tree build (keeps one side, built again after the merge)` and `merge.pmx-generated.driver` = `true` (the driver leaves its own side as the result and says "done");
   - one line `<collection path from the repository top> merge=pmx-generated` added at the end of `.gitattributes` at the top of the repository when it is not there yet (atomic, refused through a link). A later line wins in that file, so this also overrides a `*.json merge=treemerge` rule for this one file. A clone without the config line merges the file as plain text, as today.

## Where the hook files go
- The hooks folder is asked from git: `git rev-parse --git-path hooks`, resolved from the current folder.
- **pmx writes only into this clone's own hooks folder**: the real path of that folder must equal the real path of `<git rev-parse --git-common-dir>/hooks`. Any other place (`core.hooksPath` pointing into the work tree such as `.husky`, or at a folder outside the repository such as a global hooks folder) is refused and nothing is written: `this clone keeps its hooks in <dir>, which pmx did not make and which may be shared. pmx does not write there. Add these lines yourself:\n  <dir>/pre-commit:     <line>\n  <dir>/post-merge:     <line>\n  <dir>/post-rewrite:   <line>`.
- Files are written with `writeAtomic`, then `chmod 755`. Refused when a file or the hooks folder is a link.
- These files, the two config keys and the `.gitattributes` line are the places outside the tree folder, the collection file, `.pmx/` and pmx.local.json that pmx writes. State it in the README.

## The hook file (the same for all three, apart from the last word)
```
#!/bin/sh
# pmx-tree-hook 1 - written by "pmx tree hook". Remove it with: <pmx> tree hook --remove
command -v node >/dev/null 2>&1 || { echo "pmx: this hook needs node on the PATH. To commit without it: git commit --no-verify" >&2; exit 1; }
d="$(git rev-parse --show-toplevel)"/'<prefix>'
[ -d "$d" ] || exit 0
cd "$d" || exit 0
[ -f '<path of pmx.js>' ] || exit 0
exec node '<path of pmx.js>' tree hook run
```
- post-merge ends with `tree hook after`; post-rewrite ends with `tree hook after "$1"`. In those two the `command -v node` line ends with `exit 0` and prints nothing.
- `<prefix>` is `git rev-parse --show-prefix` at install time (empty when the project is the top of the repository). It sits in its own single-quoted piece outside the double quotes, so nothing in a folder name is expanded by sh.
- `<path of pmx.js>` is relative to the project root, with forward slashes, when pmx.js lies inside the repository; otherwise the absolute path with forward slashes.
- Both are quoted for sh (`'` becomes `'\''`). `pmx.SELF` is not used here.
- On a branch where the project folder or pmx.js is not there, the hook does nothing and the commit goes on.
- On Windows, Git runs the file with its own sh, and forward slashes work there.

## Who owns a hook file
pmx owns a file only when its **whole text** equals what pmx would write now, or the text of an older hook version (a small list `HOOK_TEXTS`; one entry today).
- A file that is not there: written.
- A file pmx owns: rewritten.
- Any other file, also one with the mark line and other lines added by hand: not touched.
- `tree hook` looks at all three first. When one is not owned, **nothing at all is written**, exit 2: `<path> is there already and pmx did not write it (or it was changed by hand). pmx leaves it as it is. To get the same, add this line to it:\n  <line>` for each such file, where `<line>` is `( cd '<project folder from the top>' && node '<path>' tree hook run ) || exit 1` for pre-commit and `( cd ... && node '<path>' tree hook after )` for the other two (without the `cd` part when there is no prefix).

## What `tree hook run` does (pre-commit)
The current folder is the project root. git has set its index variables and the git calls inherit them. The order matters: a commit that has nothing to do with the collection must never be stopped.
1. `git diff --cached --name-only -z --relative`. Deletions count.
2. `findTrees()`. For each folder with a staged path under it, read its note with `readMeta` inside try/catch; skip folders that are not role source or cannot be read. If nothing is left: exit 0, silent. Up to here pmx.config.json and pmx.local.json are not read (make sure `run()` does not read them for this route).
3. **`git commit <file>`** uses a temporary index, and what the hook stages there does not reach the real index (tried by a critic on git 2.43: the commit gets the new JSON, the index keeps the old one, and the next commit puts the old one back). So when `path.basename(process.env.GIT_INDEX_FILE || '')` starts with `next-index-`: exit 1 with `pmx: commit stopped. "git commit <file>" cannot take the generated JSON along. Do: git add <files>, then git commit (without file names).` `git commit -a` works and needs no special case.
4. `openTree({ tree })`, then **build what is being committed**, not what is on disk:
   - empty `.pmx/hook-tree/` (inside the ignored `.pmx/`, never through a link), then write the staged files of the tree there: `git ls-files -z -- <tree>` given to `git checkout-index -z --stdin --prefix=<absolute path of .pmx/hook-tree>/`. The implementer checks where the files land for a project in a subfolder and finds the copy of the tree from that.
   - `build(<copy of the tree>, { scripts: {} }, null, <the options buildFiles gives>)`, which is `buildFiles` with the folder swapped. In messages the path of the copy is replaced by `<tree>/`.
   - the staged JSON is read with `git cat-file --filters :./<collection>` (null when it is not staged).
5. **Guard for a JSON staged by hand**: when no merge is being finished (`git rev-parse -q --verify MERGE_HEAD` fails) and the staged JSON parses, differs from what the build gives, and is neither the committed version (`atHead`) nor what was built here last (`ws.packCopy`): stop with the `edited` hint below. While a merge is being finished the guard is off: one side of the JSON was kept by the merge rule and is known to be old.
6. On build errors: print `reportPack`'s own `TREE BUILD REFUSED - fix these first` list, then `pmx: commit stopped. Fix this and commit again. To commit without the check: git commit --no-verify`, exit 1. Two added hints, chosen by the error:
   - a test was removed: `If the test was removed on purpose: <pmx> tree build --allow-test-removal, then git add <collection> and commit again` (the staged JSON then already matches, and step 7 has nothing to do; the implementer makes sure the removed-test guard accepts a staged JSON that equals the build)
   - the JSON was edited directly: `If the files are right and the JSON is not: <pmx> tree build --force, then git add <collection> and commit again. If the JSON is right: <pmx> tree import`
7. On success, the text is `render(<staged JSON>, ...)` as `buildSource` does it (or `canonical` when there is none). Unless `git check-ignore -q <collection>` says the file is ignored:
   - when the text differs from the staged one: `git hash-object -w --path <collection> --stdin`, then `git update-index --add --cacheinfo 100644,<blob>,<path from the repository top>`, and print `pmx: built <collection> and added it to this commit`. Otherwise print nothing.
   - the file on disk gets the same text (`writeAtomic`, and `rememberPack`), so `git status` is clean and a later `tree build` does not call it edited. Exception: when the file on disk was edited by hand (it is neither the old staged text, nor the committed version, nor what was built last), it is left and one line says: `pmx: <collection> on disk was edited by hand and is left as it is`.
   - when files of the tree on disk hold more than the commit (a partial commit), one line: `pmx: <collection> now matches this commit. Your other changes in <tree>/ are not in it yet; the commit that holds them brings them in.`
8. Only the collection file is ever staged. A Problem is printed as `pmx: <message>` and the exit code is 1, so the commit stops.

With this, a commit of part of the work (`git add -p`, a changelist of an editor) is fine: the committed JSON always matches the committed files. There is no "changed but not staged" stop.

## What `tree hook after` does (post-merge, post-rewrite)
- With the word `amend` (post-rewrite after `git commit --amend`): nothing, the pre-commit hook has run.
- Otherwise, for each source tree: `packTree(ws, { force: true })` from the files on disk, as `tree build --force`. When the JSON changed: `pmx: built <collection> again after the merge. It is changed now: git add <collection> and commit it.` When it did not change: nothing.
- Build errors are printed as the `TREE BUILD REFUSED` list with `pmx: after the merge the files do not build. Fix them, then: <pmx> tree build`.
- The exit code is always 0 and any Problem is one `pmx:` line: these hooks cannot stop anything.

## Merges, stated in the README
- Two branches that each change a request both change the generated JSON. With the merge rule, git never reports a conflict in it and never mixes it line by line: it keeps one side.
- After a merge or a rebase that git finishes by itself, the after-merge hook builds the JSON from the merged files and asks for one more commit.
- A merge with conflicts in the files ends with a normal commit; the pre-commit hook builds the JSON for it.
- Conflicts are then only ever in the affected request or script file.
- Jenkins keeps checking with `tree verify`; a clone without the hook shows up there.
- Rejected from the critics: a documented mode with the JSON not committed at all. It is not verified that every command works without the committed file, and the merge rule plus hooks cover the conflict case.

## Install output
```
hooks written: .git/hooks/pre-commit, post-merge, post-rewrite
merge rule: <collection> is never a conflict (see .gitattributes; commit that file to share the rule)
From now on, a commit that holds files of <tree>/ builds <collection> from them and adds it to the commit.
It works in this clone only: every colleague runs this once. Jenkins keeps checking with: <pmx> tree verify
Remove it with: <pmx> tree hook --remove
```
A second run prints the same.

## Refusals and edges
- **No git** (`git rev-parse` fails or git is missing): `this folder is not in a git repository, so there is no commit to hook into`
- **No source tree here**: `the hook is for files that are the source (tree adopt). Nothing here is that.` When only working copies exist, add: ` A temporary working copy is taken back with tree finish.`
- **A hook file pmx does not own**, **a hooks folder elsewhere**: as above, exit 2, nothing written (also no config and no `.gitattributes` line).
- **`--remove`**: removes each of the three files that pmx owns (`hook removed: <path>`), names each it leaves (`<path> was not written by pmx, or was changed by hand. It is left as it is. Remove the pmx line yourself.`), and unsets the two config keys. The `.gitattributes` line stays (without the config, git merges the file as plain text) and one line says so. When nothing was there: `there is no commit hook here`. Exit 0.
- **Any other word**: `tree hook knows "run", "after" and --remove`

## Help
HELP "Files as the source": `tree hook                       this clone builds the JSON at every commit and after every merge (--remove takes it out)`.

## Check 18 ("the commit hook")
Every `git commit` goes through `spawnSync` with the test's `-c` identity.
- **Setup**: scratch repo, demo, `tree adopt`, `.pmx/` in `.gitignore`, first commit. `tree hook` exits 0; the three files exist, each equal to what pmx writes, and executable (skip the mode assert on win32); `git config merge.pmx-generated.driver` is `true`; `.gitattributes` holds the line once, also after a second `tree hook`.
- **A normal commit**: edit `Smoke/Ping.test.js`, `git add` only that file, commit exits 0. `git show --stat HEAD` lists the test file and the collection JSON. `tree verify` exits 0. `git status --porcelain` is empty.
- **A commit without tree files** (a README): exits 0 and the JSON is not in it. With pmx.config.json broken (not JSON) such a commit still exits 0.
- **A partial commit**: edit two tree files and add one. The commit exits 0. The committed JSON equals what the committed files build to: check out HEAD into a second scratch folder and `tree verify` exits 0 there. The other file is still modified on disk. Then commit the second file: exit 0 and verify passes.
- **A file not tracked**: `tree new "Smoke / Version"`, add only `Smoke/folder.js`: the commit exits 1 with `TREE BUILD REFUSED` (the pointer names a file the commit does not hold) and HEAD is unchanged. After `git add <tree>` it exits 0 and verify passes.
- **`git commit -a`**: works and the JSON is in the commit.
- **`git commit <path>`**: exits 1 with `cannot take the generated JSON along`; HEAD is unchanged.
- **A refused build**: a syntax error in a staged script gives exit 1 with `TREE BUILD REFUSED` and `commit stopped`; HEAD is unchanged. With `--no-verify` the commit goes through.
- **A removed test**: prints the `--allow-test-removal` hint; after the hinted steps the commit exits 0.
- **A JSON staged by hand**: exit 1 with the `tree build --force` hint.
- **Two branches**: branch a edits `Smoke/Ping.test.js`, branch b edits `Orders/Open_orders.test.js`, each committed through the hook. `git merge` exits 0 with no conflict, prints `built ... again after the merge`, and after `git add` plus commit `tree verify` exits 0. The same two branches with `git rebase`. A third case with a real conflict in one script file: after fixing it, `git add` and `git commit` exit 0 and verify passes.
- **A branch without the tool**: with pmx.js moved away from the path the hook names, a commit exits 0.
- **A foreign hook**: write a pre-commit file of your own. `tree hook` exits 2 with `pmx did not write it`; the file is byte for byte the same; post-merge and post-rewrite were not written. `tree hook --remove` leaves it and names it.
- **A hook changed by hand**: add a line under the pmx hook. `tree hook` exits 2 and `--remove` leaves the file, both with `changed by hand`.
- **Hooks elsewhere**: `git config core.hooksPath <dir outside the repository>` gives exit 2 and no file there. The same for a folder inside the work tree.
- **Removing**: `tree hook --remove` removes the three files and the config; a second time says `there is no commit hook here`.
- **Project in a subfolder** whose name holds a space and a `$`: `tree hook` run from it, commit from the repository top: the JSON is added.
- **No git**: `tree hook` in a folder without git exits 2 with the plain message.
- **A working copy only**: exits 2.
- **Every refusal**: no `\n\s+at ` in the output.

## Final README pass
- **Commands table**: rows for `tree new`, `tree run`, `tree env`, `tree env use`, `tree ide`, `tree hook`. The sentence about refused options says that an option of another command is refused.
- **"The files as the source"**, a closing part "A day with the files" in the words of the colleague's list:
  - add a request (`tree new`);
  - run it (`tree run`, with `--first` for a login);
  - pick your environment (`tree env use`, or in the page; both are the same choice);
  - open the folder in any editor (`tree ide`);
  - commit, and the hook builds the JSON from what is committed, so a push holds only the files that changed plus the generated JSON;
  - merge, and a conflict is only ever in the affected file; the JSON is built again;
  - Jenkins runs `tree verify` and then `tree test --env ci` (or newman on the JSON); nobody edits the JSON by hand.
- **Setup step 4**: `.pmx/` and `pmx.local.json` in `.gitignore`.
- **"What leaves your machine"**:
  - pmx writes in the tree folder, the collection file, `.pmx/`, pmx.local.json at the project root and, only by `tree hook`, three hook files and two config keys in this clone's git folder and one line in `.gitattributes`;
  - the sentence of step 3 about where a run sends requests;
  - answers are shown and kept in memory, never written;
  - the page gets environment names, not values, with the stated exception of the address and the answer of a run, where secret values and cookies are shown as `*****`;
  - a named environment file can take a whole value `${NAME}` from the shell, and each run names what it took.
- **"What this trial does not do yet"**:
  - `pmx test` (fix mode) does not know the named environments;
  - `tree run` keeps no variables between two commands (use `--first` or `runFirst`);
  - a script error has no line number;
  - the hook needs one run per clone, and `git commit <file>` is refused where it is installed;
  - `tree new` cannot copy an existing request yet.
- **Self-test**: 61 checks (23 + 19 + 19), with the five new subjects named in the prose list.
- **Last**: read HELP, the pmx.js HELP tree lines and the header comment once against the `ONLY` table, so all four places name the same commands and options.
```
