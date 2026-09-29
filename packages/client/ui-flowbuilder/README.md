# @deepseek-ai/dsh-client-ui-flowbuilder

English

The Workflows tab (`dagflow` entry of the conversation view slot, label "Workflows"/工作流): an editable canvas over the `flow.*` wire domain — flow list editing, a palette, drag-to-position node cards with typed in/out ports, a node inspector, save, run with a polling per-node status overlay, and the reusable block library.

## Model Experience

### Editable workflow canvas

#### What the user sees

The tab lists the user's saved workflows (name field, save button) and renders the selected definition as node cards connected by curved edges. The palette adds nodes of every executor kind; clicking an output port then an input port connects them (one edge per input port, enforced client-side too); the inspector edits title/kind/code (code and condition nodes get a code textarea; library nodes a block picker); Delete or Backspace removes the selection; the edge strip disconnects. Save writes through `flow.save` (wire rejections surface in the error strip); Run starts `flow.run` and polls `flow.runGet` every ~800 ms until terminal, tinting node borders by state and showing node errors and the run result. The library drawer lists `flow.libraryList` blocks, instantiates a block onto the canvas, and saves the selected node as a block via `flow.librarySave`.

#### Token effect

None server-side beyond the `flow.*` RPCs the user triggers; the tab injects no prompts and registers no tools.

#### KV Cache effect

None: canvas interactions are wire calls, never session-log content.

## Known Limitations and Deferred Work

- **No pan/zoom yet** — the canvas scrolls; pan and zoom controls (present in the old read-only projection) land with canvas polish.
- **Params editing is read-only in the inspector** — param key/value rows render but the editor for adding params lands with canvas polish; code, kind, title, and block binding are fully editable.
- **`agent` nodes cannot execute** — the backend executor is documented as unavailable (`dsh-flowbuilder-service` README); the canvas lets you place one but a run fails that node loudly.
