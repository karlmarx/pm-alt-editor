# pm-alt-editor

Two tools, no dependencies:

- **`treemerge`** — an interactive 3-way merge tool that understands structure. Any JSON file, with Postman collections as a built-in profile; any other text file line by line.
- **`pmx`** — fix failing Postman / newman tests without anyone editing the collection JSON.

## The modes

There are four ways of working. Each has its own commands.

![The four modes and the part of a collection each works on](docs/modes.svg)

| Mode | Use it when | Commands | What it turns into files |
|---|---|---|---|
| **Fix tests** | newman assertions fail and the test scripts need to change | `pmx unpack`, `test`, `test --failed`, `digest`, `sync`, `pack`, `loop` | Only the scripts, one `.js` file each |
| **Review** | you want to look at your script edits before committing | `pmx view` | Nothing. It writes one read-only HTML page with the diff |
| **Merge** | git reports a conflict in a collection or in another JSON file | `treemerge`, or `pmx merge` and `pmx diff` | Nothing you need to edit, apart from a small file for each real conflict (under `.treemerge/`) |
| **Whole collection** (experimental) | you want to change requests, variables or shared scripts, or add and remove requests | `pmx tree unpack`, `tree ui`, `tree status`, `tree test`, `tree pack`, `tree finish` | Everything, as temporary files: each request, each folder and the collection itself, plus the scripts |

The first three were here from the start. The fourth was added later, as a trial of a broader idea: working on the whole collection as files, not only on its scripts, with a local page to edit them. It is a separate mode in its own files (`pmx-tree.js`, `pmx-tree.ui.html`) and changes nothing about the other three.

Where each one is described: [Merge](#treemerge), [Fix tests](#pmx), [Review](#commands), [Whole collection](#experimental-the-whole-collection-as-files).

---

# treemerge

git merges a file line by line. For a big JSON file that means conflicts that are not real ones (two branches each append an item to the same list; both edit different parts of one script) and real ones shown as escaped strings in a very large file.

`treemerge` merges by structure, then lets you settle what is left by clicking.

![treemerge resolving a conflict](docs/treemerge.png)

## Use it

```bash
git merge dev
```

If anything conflicts:

```bash
node tools/treemerge.js
```

It takes the three versions git already holds for every conflicted file, merges what can be merged, and, if decisions are left, opens a page in your browser (served from your own machine only):

- **Left:** every conflict, plus everything that merged automatically, grouped by where it lives (request, key path).
- **Right:** the conflict block with OURS and THEIRS side by side and the differing words highlighted. Click **Ours**, **Theirs**, **Both** or **Edit**. Keys: `1` `2` `3`, `n` next conflict, `j`/`k` move, `u` undo.
- Automatic changes can be reviewed and switched off one by one ("Do not apply").
- **Save & close** writes the file and runs `git add` when nothing is left open.

Decisions are stored as you go, so you can stop and come back.

The **Merged** tab lists what was merged without asking. Here the two branches edited different lines of the same script:

![treemerge's Merged tab showing two automatic changes to one script, each with a Do not apply button](docs/treemerge-merged.png)

### What merges on its own

| Situation | Result |
|---|---|
| Both sides add different keys to one object, or items to one list | Both kept |
| Both edit the same script or multi-line string on different lines | Merged line by line |
| One side only re-indents a script | Not a change; the other side's edit wins |
| One side renames an item, the other edits it | Renamed and edited |
| Lists of objects with an `id` / `key` / `name` (inferred, must be unique) | Matched by that, not by position |
| Lists of the same length with no identity | Merged slot by slot |
| Postman ids and export timestamps regenerated on both sides | Ignored |
| One side deletes what the other never touched | Deleted |

### What you get asked about

- Both sides changed the same lines of a script or text.
- Both sides set one value differently.
- One side deleted what the other changed.
- Both sides extended a plain list (`["a","b"]`) at the same spot. "Both" usually settles it.
- A line-by-line merge that no longer parses as JavaScript (Postman scripts). The tool will not accept it until it does.

### Three ways to settle conflicts

| | Command | For |
|---|---|---|
| Browser | `node tools/treemerge.js` | You, at a desk. Default when run in a terminal |
| Terminal | `node tools/treemerge.js --tui` | SSH sessions. Answer `o` / `t` / `b` / `e` per block |
| Files and flags | `node tools/treemerge.js --no-ui` | Scripts and coding agents. Prints a numbered list; edit the small conflict files it names, or `--take-ours 1,3` / `--take-theirs 2` / `all` |

All three share the same stored decisions.

### Look before you merge

```bash
node tools/treemerge.js path/to/file.json --theirs origin/dev
```

Previews the merge and its conflicts. Your file is not changed; treemerge only keeps its notes in the hidden `.treemerge/` folder. Run in a terminal, it opens the browser view when there are conflicts. Add `--no-ui` for a text-only preview.

```bash
node tools/treemerge.js diff path/to/file.json HEAD origin/dev
```

What differs between two versions, by structure. `--only <text>` filters, `--full` prints changed script lines.

### Let git use it

```bash
node tools/treemerge.js install "*.postman_collection.json" "*.json"
```

- `git merge`, `rebase` and `cherry-pick` then merge those files by structure on their own, and only stop for real conflicts.
- `git mergetool -t treemerge` opens the interactive view for any conflicted file.
- Commit the `.gitattributes` it writes. Each teammate runs `install` once.

### How it knows what a file is

- **Postman collections and environments** (detected by name or content): folders and requests by name, events by `listen`, headers / variables / query params by `key`, scripts as code, `url` as one unit.
- **Any other JSON**: objects by key; for each list it looks for a field (`id`, `key`, `name`, ...) present on every element and unique in all three versions.
- **Anything that is not JSON**: line by line.

The file is written back in its own layout: untouched parts keep their exact bytes (indentation, inline lists, escapes, `1.0`), and only containers that changed are laid out again.

### Limits

- An item **moved to another list** on one side and edited on the other shows up as a delete-vs-change conflict, not a clean merge.
- Two items with the same name in one Postman folder are paired by position.
- A clean line-by-line merge can still be wrong in meaning (one side renames a variable, the other adds a use of the old name). Review the "Merged" tab and run your tests.
- JSON with comments is treated as plain text.
- During a rebase git swaps the roles: OURS is the branch you are rebasing onto.
- The browser UI was tested in Chromium.

---

# pmx

Fix failing Postman tests by editing small `.js` files instead of the collection.

Big collections store every script as a JSON array of escaped strings (`"    var x = \"a\";\r",`). Editing that by hand or with an LLM goes wrong in the same ways every time: escaping mistakes, a small fix that shows up as a huge diff because something got re-indented, and a fix applied to one copy of a helper but not the other requests it was pasted into.

`pmx` removes those failure modes with plain scripting:

| Problem | What pmx does |
|---|---|
| A huge JSON file full of escaped strings | `unpack` writes each script as a normal `.js` file. You edit that. |
| Noise diffs | `pack` splices only the lines you changed back into the **original bytes**. Whitespace-only edits are dropped. |
| Broken scripts, deleted tests | `pack` refuses syntax errors and any drop in the number of `pm.test(...)` calls. |
| A very long CI log | `digest` / `test` print a short list: request, test, `file:line`, the distinct error messages, and a list diff when two lists are compared. |
| Slow full runs | `test --failed` re-runs only the requests that failed. |
| Same helper pasted into several requests | `sync` finds identical copies of the block you changed and applies the same edit. |
| Tests that quietly stop running | The first run is the baseline; later runs flag any test that ran before and no longer does, and mark newly broken tests as `NEW`. |
| Reviewing a fix inside escaped JSON | `view` writes a read-only HTML page with the diff of every edited script, next to the guard results and the last test run. |

New here? Do the demo below first. It takes about five minutes and needs no real API.

## Try it: the demo

The repo ships a small sample collection with three failing requests, and a mock API for it to call. The API is a pretend bookshop; everything in it is made up. You need Node.js 18 or newer.

**1. Install, and create the sample collection**

```bash
npm install
```

```bash
node demo/make-demo.js
```

**2. Start the mock API.** Use a second terminal and leave it running.

```bash
node demo/mock-server.js
```

**3. Unpack the collection and run the tests.** Back in the first terminal:

```bash
cd demo
```

```bash
node ../pmx.js unpack Demo.postman_collection.json
```

```bash
node ../pmx.js test
```

The run fails, and instead of newman's full output you get this (one of the three failing requests shown):

```text
RESULT: FAIL - 5 of 10 assertions failed, in 3 request(s)   [full run]

X Catalogue / Genres and formats
  1x FAILED TEST: "Catalogue lists the right genres"
     edit -> .pmx/Demo/scripts/Catalogue/Genres_and_formats.test.js:9
     1x genres: API has ["cooking","history","poetry","travel"], we expect ["history","cooking","poetry"]: expected false to be true
        hint: only in 1st list: ["travel"]   only in 2nd list: []
  1x FAILED TEST: "Catalogue lists the right formats"
     edit -> .pmx/Demo/scripts/Catalogue/Genres_and_formats.test.js:9
     1x formats: API has ["ebook","hardcover","paperback"], we expect ["hardcover","paperback","ebook"]: expected false to be true
        hint: same members, different ORDER
  scripts for this request: .pmx/Demo/scripts/Catalogue/Genres_and_formats.test.js   (+1 inherited folder/collection script(s))
  failing calls: GET http://127.0.0.1:4010/catalogue -> 200

NEXT: edit the .js file(s) named above (smallest change), then run: node ../pmx.js test --failed
```

`edit ->` is the file and line of the failing test. The hints say what is wrong: the API has a `travel` genre that the test does not know about, and it returns the formats in a different order than the test lists them. For this demo the rule is that `travel` is a real genre and that the order does not matter, so the test is what needs to change.

**4. Fix the first script.** Open `demo/.pmx/Demo/scripts/Catalogue/Genres_and_formats.test.js` in your editor and make these two changes:

```diff
     pm.test("Catalogue lists the right " + what, function () {
-        const same = fromApi.length === wanted.length && fromApi.every(function (name, i) {
-            return name === wanted[i];
+        const same = fromApi.length === wanted.length && fromApi.every(function (name) {
+            return wanted.includes(name);
         });
```

```diff
-expectSameNames("genres", body.genres, ["history", "cooking", "poetry"]);
+expectSameNames("genres", body.genres, ["history", "cooking", "poetry", "travel"]);
```

**5. Re-run only the requests that failed.**

```bash
node ../pmx.js test --failed
```

`Catalogue / Genres and formats` is gone from the failure list. The output ends with a warning, because the same helper function is pasted into a second request:

```text
your edits so far (1 script(s)):
  M .pmx/Demo/scripts/Catalogue/Genres_and_formats.test.js   +3 -3
TWIN CODE: 1 place(s) still contain the old version of code you just changed:
  .pmx/Demo/scripts/Catalogue/Staff_picks/Picks_by_genre.test.js:11   (same block you edited at .pmx/Demo/scripts/Catalogue/Genres_and_formats.test.js:10)
  -> copy your edit there automatically with: node ../pmx.js sync
```

Let pmx copy the edit:

```bash
node ../pmx.js sync
```

**6. Fix the second script.** The remaining failure says that two open orders are waiting for the books `b-104` and `b-107`. Those two can only be pre-ordered so far, and the rule for this demo is that a pre-ordered book counts as available. Open `demo/.pmx/Demo/scripts/Orders/Open_orders.test.js` and allow it:

```diff
         const stuck = order.lines.filter(function (line) {
-            return line.status !== "in stock";
+            return line.status !== "in stock" && line.status !== "preorder";
         }).map(function (line) {
```

**7. Re-run the failed requests, then confirm with the full run.**

```bash
node ../pmx.js test --failed
```

```bash
node ../pmx.js test
```

```text
RESULT: PASS - 10 assertions, 0 failed   [full run]
```

**8. Look at what you changed.**

```bash
node ../pmx.js view --open
```

![The pmx view page: three changed scripts, guard results, and the line-by-line diff](docs/view.png)

Six lines of the 239-line collection file changed (`git diff` shows each as one removed and one added line). Every other byte is the same as before. In a real repo this is where you commit it.

To start the demo over, run `node ../pmx.js restore --all` and then `node ../pmx.js pack`.

## Use it on your own collection

### Setup (once per repo)

1. Copy `pmx.js` into the repo (for example `tools/pmx.js`). It has no dependencies. For `merge`, `diff` and `merge-install`, put `treemerge.js` and `treemerge.ui.html` next to it.
2. Run `npm i -D newman`. It is only needed for `test` and `loop`.
3. Copy `pmx.config.example.json` to `pmx.config.json` in the repo root and fill it in:

   | Key | What to put there |
   |---|---|
   | `collection` | Path to your `*.postman_collection.json`. |
   | `newman` | The options you would pass to newman (environment file, timeouts, variables). Same names as the [newman library](https://github.com/postmanlabs/newman#api-reference). `${NAME}` is replaced from environment variables, so tokens stay out of the file. |
   | `alwaysRun` | Names of requests that must run before anything else, such as a login. `test --failed` runs these plus the failed requests. |

4. Add `.pmx/` to `.gitignore`.
5. Unpack the collection:

   ```bash
   node tools/pmx.js unpack path/to/Your.postman_collection.json
   ```

Run every command from the repo root.

### Fix a failing run

**If you can run newman from your machine**

1. Get the failure list:

   ```bash
   node tools/pmx.js test
   ```

2. Open the file named after `edit ->` and make the smallest change that fixes it.
3. Re-run only what failed. Repeat steps 2 and 3 until it passes.

   ```bash
   node tools/pmx.js test --failed
   ```

4. If the output says `TWIN CODE`, run `node tools/pmx.js sync`, then `test --failed` again.
5. Confirm with the full run:

   ```bash
   node tools/pmx.js test
   ```

6. Review the change:

   ```bash
   node tools/pmx.js view --open
   ```

7. Commit the collection file. Nothing under `.pmx/` is committed.

**If you only have a CI log**

1. Save the newman or Jenkins console output to a file and get the failure list from it:

   ```bash
   node tools/pmx.js digest console.txt
   ```

2. Edit the file named after `edit ->`.
3. Write your edits into the collection. `digest` does not do this for you; `test` does.

   ```bash
   node tools/pmx.js pack
   ```

4. Review with `node tools/pmx.js view --open`, commit, push, and run `digest` on the next log.

### What the messages mean

| Message | Meaning | What to do |
|---|---|---|
| `edit -> file:line` | Where the failing `pm.test` lives. | Open that file at that line. |
| `PACK REFUSED` | An edit has a syntax error or removed a `pm.test`. The collection file was not changed. | Fix exactly what it lists. |
| `TWIN CODE` | Other requests contain the old version of the code you changed. | Run `sync`. |
| `NEW: this passed before your edits` | Your edit broke a test that was passing. | Undo that part of the edit. |
| `TESTS THAT STOPPED RUNNING` | A test that ran in the first run no longer runs at all. | Bring it back. If the removal is intended, a human re-runs with `--rebaseline`. |
| `whitespace-only line edit(s) ignored` | Re-indenting and similar edits were dropped so the diff stays small. | Nothing. Use `--keep-whitespace` if the whitespace change was the point. |
| `.pmx/ is tracked by git` | The scratch folder came in through git, for example with a merged branch. pmx does not pack from files it did not write itself. | Run the two commands it prints, then `unpack` again. |
| `was changed by something other than pmx` | The collection file changed since `unpack` (a pull, a Postman export). | Run `unpack` again. If you still have edits that are not in the collection, it stops and asks for `--force`, which discards them. Copy those `.js` files somewhere first and re-apply the edits afterwards. |

### Let an AI assistant make the edit

With the `claude` CLI installed, the script can run the whole loop:

```bash
node tools/pmx.js loop --why "One or two sentences: what changed and what is now correct."
```

`loop` runs newman, hands the failure list and your sentence to `claude -p --model haiku` (edit tools only, no shell), syncs twin code, re-checks the guards, re-runs the failed requests, then the full suite. It stops when green, after `--max` attempts (default 4), or when the model answers `NEEDS-HUMAN`.

Inside Claude Code you can use the agent instead: copy `claude/postman-fixer.md` to `.claude/agents/`.

With any other assistant, give it the rules and procedure from `claude/postman-fixer.md` and let it edit the `.js` files. The guards in `pack` apply no matter who made the edit.

## Commands

| Command | Does |
|---|---|
| `unpack <collection.json>` | Write scripts to `.pmx/<name>/scripts/**.js` |
| `ls [text]` | List script files, filtered by request name |
| `digest <log\|->` | Failure list from a newman or Jenkins console log |
| `test [--failed] [--folder <name>]` | Pack, run newman, print the failure list. Exit 0 = green |
| `sync` | Copy your edit to identical copies in other scripts |
| `status` | Show pending edits. Writes nothing |
| `view [--open]` | Write the edits as a read-only HTML diff page (`.pmx/<name>/diff.html`) |
| `pack` | Write edits into the collection (`test` does this for you) |
| `restore <file>` / `restore --all` | Throw away edits |
| `loop --why "..." [--model haiku] [--max 4]` | The automated fix loop |
| `merge` / `diff` / `merge-install` | Shortcuts to treemerge for the collection: the configured one, or the only one git tracks. treemerge's own switches, such as `--no-ui`, pass through |

Human-only overrides: `--keep-whitespace`, `--allow-test-removal`, `--rebaseline`, `--force`.

The `view` page shows each changed script as a unified or side-by-side diff with the changed words marked, whether the guards passed, whether the collection file already contains the edits, twin code that `sync` has not updated yet, and the last test result. It is a snapshot: run `view` again after more edits. Without `--open` it only writes the file and prints its address.

One script in the side-by-side layout:

![One changed script in the side-by-side layout, with the removed and added words marked](docs/view-side-by-side.png)

When something needs attention, the top of the page says so. Here a guard refused an edit that removed a test, a pasted copy of the changed code is still out of date, and the scripts were edited after the last test run:

![The top of the view page reporting a refused pack, twin code and a stale test run](docs/view-problems.png)

## Experimental: the whole collection as files

`pmx unpack` turns only the scripts into files. `pmx tree` is a separate, experimental mode that does it for everything: each request, each folder and the collection itself.

The files are a **temporary working copy**. The collection JSON stays the file that is kept and merged.

![The four steps: unpack, edit, test, finish](docs/tree-steps.svg)

### Try it on the demo

You need the sample collection and the running mock API: steps 1 and 2 of [the demo above](#try-it-the-demo). If you did that demo to the end, its fixes are in the collection, so create a fresh one first: `node demo/make-demo.js` from the repo root.

```bash
cd demo
```

```bash
node ../pmx.js tree ui Demo.postman_collection.json
```

This unpacks the collection and opens the page in your browser. **Run tests** shows the same 5 failures as the first demo. Click one to land on its line, fix it, run again.

![The test results in the page: failing tests by request, each with its file and line](docs/tree-ui-results.png)

### The page

![The page: folders and requests on the left, one request's form on the right](docs/tree-ui.png)

| Where | What you do there |
|---|---|
| Tree on the left | Pick a request or folder. Add, duplicate, move, remove, put back. `M` = changed, `A` = new; the last run's passes and failures are shown per request |
| **Request** | Name, method, URL, query parameters, headers, body, auth. The URL text and its parts stay in step |
| **Scripts** | Pre-request script and tests as plain code. Syntax is checked while you type |
| **Inherited** | What runs before and after this request, from the collection and folders above it, and which variables it can use |
| **Changes** | Diff of this request against the collection as it was unpacked, unified or side by side |
| **Raw** | The definition as JSON, for anything the forms do not cover |
| The collection itself (top of the tree) | Collection variables, shared scripts and auth. A table lists every `{{variable}}` in use and where its value comes from |
| **All changes**, **Collection JSON** | Every change in one place, and the exact lines **Pack** will write into the collection JSON |
| **Run tests**, **Run this** | Pack, then newman on everything or on one folder or request, with an environment file if you pick one |

Every edit is written to the files a moment after you stop typing (in **Raw**: when you press **Apply** or leave the tab). Nothing reaches the collection JSON until **Pack**, **Run tests** or **Run this**.

- **Revert** puts a request and its scripts back as they were unpacked. On a folder it puts back the folder's own fields; what is in the folder stays.
- **Remove** takes a request off its folder's list. **Put back** returns it with the edits it had.
- If a file changes on disk while the page shows it (you edited it by hand), the page does not write its older copy over it. It tells you and shows the file as it is now.

A failing test, opened at its line:

![A test script in the page, with the failures of the last run listed under it](docs/tree-ui-scripts.png)

One request's changes, side by side:

![The Changes tab: the request's definition before and after](docs/tree-ui-changes.png)

What **Pack** will write. Only the edited lines differ from the original file:

![The Collection JSON view: a diff of the collection file](docs/tree-ui-json.png)

The page talks to pmx on your own machine and to nothing else:

![What the page talks to](docs/tree-page.svg)

### On a branch, so the change can be reviewed file by file

Name a folder you commit, instead of the default scratch folder.

![The files on a branch: unpack, edits, finish](docs/tree-branch.svg)

```bash
node tools/pmx.js tree unpack path/to/Your.postman_collection.json --tree collection-files
```

```bash
git add collection-files && git commit -m "Unpack the collection (no changes yet)"
```

Edit in the page (`node tools/pmx.js tree ui`) or by hand, and commit the folder as you go (`git add collection-files`). Those commits are what reviewers read. A test run also writes the collection JSON; that change can wait for the last commit. To check where you are:

```bash
node tools/pmx.js tree status
```

```text
collection-files/  for  path/to/Your.postman_collection.json
  M collection.js
  M Orders/Open_orders.request.js   <- Orders / Open orders
  M Orders/Open_orders.test.js   <- Orders / Open orders
path/to/Your.postman_collection.json does not hold these edits yet (+17 -3 lines). Run: node tools/pmx.js tree pack
```

Before the branch is merged:

```bash
node tools/pmx.js tree finish
```

```bash
git add -A collection-files path/to/Your.postman_collection.json && git commit -m "Pack the collection"
```

`tree finish` packs one last time, checks that the collection JSON holds every edit, and removes the files. What main receives is the collection JSON, with only the edited lines changed.

If the collection JSON changes while the files are unpacked (main was merged into the branch, say), the next `tree pack` or test run merges your edits into the newer file and writes the files again from the result. From then on, changes are counted from that newer collection as it was found, so your edits stay edits. If both sides changed the same value, it refuses, names the places and writes nothing. Git will not merge over a collection JSON with uncommitted changes from a test run: commit it first, or put it back with `git checkout -- path/to/Your.postman_collection.json` (the files hold your edits).

### The files

![Which part of the collection becomes which file](docs/tree-files.svg)

A definition file (every file that is not a script) is `module.exports = ` followed by JSON. It is read as data and never run. By hand you can do everything the page does: change a URL, a header, a body or a variable, edit the scripts, add a request (write its file and list it in `$children`), remove, reorder or rename.

A file that no definition lists is not part of the collection. `tree status` marks it with `?`, the page points it out, and `tree finish` refuses to remove it. pmx never writes over such a file and never deletes one, unless you finish with `--remove-unlisted`. What a file manager or an editor leaves behind (`.DS_Store`, `Thumbs.db`, swap and backup files) is not counted.

### Commands

| Command | Does |
|---|---|
| `tree unpack <collection.json> [--tree <folder>]` | Write every request, folder and script as its own file. Default place: `.pmx/<name>/tree/` |
| `tree ui [<collection.json>]` | Open the page. Unpacks first if nothing is unpacked yet. `--no-open` only prints the link |
| `tree status` | What differs from the collection as it was unpacked, file by file. `?` marks a file that nothing lists |
| `tree pack [--ignore-whitespace] [--force]` | Build the collection JSON from the files. Only what changed moves. If the collection changed meanwhile, the edits are merged into it; `--force` writes over it instead |
| `tree test [--environment <file>] [--folder <name>]` | Pack, then run newman. Each failing test is listed with its file and line. `--folder` runs one folder or request; the name must be the only one of its kind. A run of no request at all counts as failed |
| `tree finish [--keep] [--remove-unlisted]` | Pack, check, and remove the files. Do this before merging. It stops if the folder holds files that nothing lists, unless `--remove-unlisted`. `--keep` leaves the files where they are |
| `tree check <collection.json> [--run]` | Measure the round trip without touching anything: unpack, build, compare. `--run` also compares newman results |

An option that a command does not know is refused, and `--help` only prints the help.

`tree pack` refuses a script that does not parse and a drop in the number of `pm.test` calls, as `pack` does. The count is per script. Removing a whole request, or a script from its definition, is your decision and is not refused.

Unlike `pack`, it treats an edit that only changes spacing as an edit, because a space inside a string matters. Only line breaks at the very end of a script are ignored. `--ignore-whitespace` drops spacing-only edits and says where.

### How it compares with Fix tests

| | Fix tests (`pmx unpack`, `test`, `pack`) | Whole collection (`pmx tree ...`) |
|---|---|---|
| Files you get | One per script | One per request, one per folder, one for the collection, and one per script |
| What you can change | Script code | Script code, URLs, headers, bodies, auth and variables, and which requests exist and in what order |
| Where you edit | Your editor | The page, or your editor |
| Where the files live | `.pmx/`, never committed | `.pmx/`, or a folder you commit for the life of the branch |
| Writing back | The changed script lines are spliced into the original bytes | The collection is built from the files, and bytes that did not change are copied from the original |
| newman | `pmx test`, with file and line, a list diff when two lists are compared, and `--failed` to re-run only the failures | `pmx tree test` or **Run tests**, with file and line; one folder or request on its own |
| Seeing your changes | `pmx view` | The page (**Changes**, **All changes**, **Collection JSON**) and `tree status` |
| Code pasted into several requests | `sync` copies your edit to the identical copies | Not yet. Search finds the copies; you edit each |

### What this trial does not do yet

- The forms cover the common kinds of body (raw, form, GraphQL) and auth (bearer, basic, API key). Anything else is edited in the **Raw** tab.
- When you edit a definition file by hand, the part after `module.exports = ` must be strict JSON: no comments, no trailing commas.
- A file keeps its name when you rename its request. The names follow again after the next unpack.
- Commit the collection before you unpack it into a folder you commit. Otherwise only your machine knows the unpacked version, and a fresh clone cannot tell what changed. `tree unpack` says so.
- `tree test --folder <name>` needs a name that no other folder or request has. **Run this** in the page has no such limit.
- If a colleague changes the same value that you changed, on top of a collection you already packed, the next pack refuses and names the places. Make the files and the collection say the same there, then pack again.
- Two requests of one name in a folder, one of them removed, and the collection changes underneath: the merged collection is right, but the files can no longer be told apart. `tree pack` says so and gives the command to unpack again.
- If a file changes on disk while you type in the same form, the page loads the file again and the last keystrokes are lost. It says so.
- This mode and Fix tests keep separate working copies. Use one at a time on a collection.
- It needs `pmx-tree.js` and `pmx-tree.ui.html` next to `pmx.js`. With `treemerge.js` there too, the collection keeps its layout and `tree pack` can merge; without it, the file is written in plain JSON layout.

## Limits

- Outside the experimental whole-collection mode, pmx only edits **scripts** (`event[].script.exec`). Request URLs, bodies, headers and collection variables are never touched, so a fix that needs those is a manual edit or a job for [that mode](#experimental-the-whole-collection-as-files).
- `--failed` runs the failing requests on their own. If they need a login or setup request first, list those names under `alwaysRun` in the config.
- `digest` reads newman's `#  failure  detail` table. Logs with a timestamp prefix on every line are not parsed.
- The guards catch removed tests and syntax errors. They cannot tell whether an expected value is *right*. That is what the `--why` sentence and the final diff review are for.
- If the collection file changes underneath pmx (a merge, a pull, a Postman export), `pack` stops and asks you to `unpack` again.

---

# Setup

Copy the files you want into your repo, side by side (for example `tools/`). Run every command from the repo root.

| Tool | Files to copy | Also needed |
|---|---|---|
| treemerge | `treemerge.js`, `treemerge.ui.html` | Nothing. Its scratch folder `.treemerge/` is hidden from git automatically. |
| pmx | `pmx.js` | newman, a `pmx.config.json`, and `.pmx/` in `.gitignore`. The steps are under [Setup (once per repo)](#setup-once-per-repo). |
| pmx `merge` / `diff` / `merge-install` | `pmx.js` next to the two treemerge files | Nothing more. If the repo has several collections, name one with `--collection <file>` or in `pmx.config.json`. |
| pmx `tree` (experimental) | `pmx.js`, `pmx-tree.js`, `pmx-tree.ui.html`, and `treemerge.js` | newman for `tree test` and **Run tests**. `.pmx/` in `.gitignore`. |

In Claude Code, copy `claude/*.md` to `.claude/agents/`: `merge-resolver` settles merge conflicts, `postman-fixer` fixes failing assertions. Both are written for a small model.

# What leaves your machine

| Command | Network use |
|---|---|
| pmx `unpack`, `ls`, `status`, `pack`, `sync`, `restore`, `digest`, `view` | None. They read and write local files only. |
| pmx `test` | Runs newman, which calls the hosts your collection and environment name. pmx adds no calls of its own. |
| pmx `tree unpack`, `status`, `pack`, `finish`, `check` | None. They read and write local files only. |
| pmx `tree test`, `tree check --run`, and **Run tests** in the page | Run newman, as `pmx test` does. |
| pmx `tree ui` | No outside calls. It serves the page to your own machine only (see below). |
| pmx `loop`, the `postman-fixer` agent | Send script source and failure lists (these can include response data that your tests log) to the Claude model you run them with. Use them only where your employer allows that. Everything else works without them. |
| `treemerge`, and pmx `merge` / `diff` / `merge-install` | No outside calls. They read the versions git already holds and write the merged file. |
| The `merge-resolver` agent | Sends the conflict blocks it resolves to the Claude model you run it with. Same rule as above. |

The pmx `view` page is one static file. It contains no JavaScript, loads no fonts, images or other files, and carries a Content-Security-Policy that blocks scripts and every network request. Text from your scripts, request names and the test log is escaped. Characters that cannot be seen, or that change the direction text is shown in, are displayed as `U+XXXX`: control and format characters, unusual spaces, variation selectors and blank filler letters. Nothing listens on a port.

The treemerge browser view and the `pmx tree ui` page are the two things that listen on a port. The treemerge view is served by a small server inside treemerge that accepts connections from your own machine only (`127.0.0.1`), on a random free port, and answers only requests that carry the secret key in the link it prints. It rejects requests addressed to any other host name, and it stops when you choose **Save & close** or press Ctrl+C. `--tui` and `--no-ui` start no server.

The `pmx tree ui` page is served the same way: `127.0.0.1` only, a random free port, a secret key in the link, other host names rejected. Every call the page makes also carries the key in a request header, which a page from another site cannot send. The page loads no fonts, scripts or images from anywhere, and its Content-Security-Policy allows only its own script. Text from your collection is put on the page as text, never as HTML. Through the page, pmx writes only real files inside the unpacked folder, the collection file, and its own scratch copy under `.pmx/`. A link is never followed, whether or not what it points at exists. From an environment file pmx sends the page the names of the variables, not their values. Test results are shown as newman reports them, so a failing test's message can quote a value. It stops when you press Ctrl+C.

`treemerge install` changes this clone only: it adds a merge driver and a mergetool to the clone's git config and writes the file patterns to `.gitattributes`.

Both tools treat their scratch folders (`.pmx/` and `.treemerge/`) as private. They stop if git tracks the folder or if it is a link to somewhere else, so a branch you merge cannot hand them prepared decisions or file names. They write every file through a temporary file with a random name, so a link planted in the repository cannot redirect a write.

`.pmx/` holds a full copy of the collection, the last run's output and the diff page. Keep it out of git (step 4 of the pmx setup) and treat `diff.html` like source code if you send it to someone.

The example config sets `"insecure": true`, which turns off TLS certificate checks in newman. Remove that line unless your test environment needs it.

# Self-test

```bash
npm install
```

```bash
npm test
```

55 end-to-end checks:

- **pmx** against a demo collection and a mock API: 23, including byte-identical round trips for 8 export shapes.
- **treemerge** on its own, through real `git merge` runs, in the terminal, and over the browser UI's API: 19, including 1,500 random documents.
- **The tree mode**: 13. Round trips of nine file layouts, a collection of about 1,700 requests and 250 random collections; edits through the files; what `tree pack` refuses; the files on a git branch from unpack to finish, also with a checkout that converts line ends; a collection that changes underneath (merged, clash refused, an edit made again, an edit taken back); spacing-only edits and files that nothing lists; and the page's server (who may talk to it, every edit it can make, saves of an older copy refused, newman, and that nothing is read or written through a link); and what a second review found (a collection put back after a merge, a collection wrapped in `{"collection": ...}`, two requests of one name, clones that end lines differently, options that do not exist).

The page itself has a separate check in a real browser. It needs Playwright, which the tool does not, so it is not part of `npm test`:

```bash
node test/tree-ui.browser.js
```
