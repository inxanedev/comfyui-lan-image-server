# ComfyUI LAN Control Panel

Turn any phone, tablet, or computer on your Wi-Fi into a **remote control for ComfyUI**.

Watch generations happen live, start and stop runs, and edit your generation settings — prompt, negative, size, steps, CFG, sampler, scheduler and seed — straight from the browser. No app, no account, no internet required. It started as a simple image viewer and grew into a lightweight control panel for ComfyUI over your local network.

---

## Highlights

**Watch**
- **Live preview** of the KSampler as it samples, with a **step counter** (e.g. `12 / 20`).
- **Seamless live-to-final**: the preview automatically swaps to the full-resolution finished image.
- **Session gallery** with `Prev` / `Next` and a counter, so you can flip back through everything generated this session.
- **Pinch-to-zoom & pan** on any image for inspecting details up close.
- A status pill that turns green with **Done.** when a run finishes.

**Control**
- **Run** a workflow, or **Run (Instant)** to loop generation continuously. Tap **Stop Loop** to finish after the current image.
- **Cancel** instantly to abort sampling and clear the queue.
- Works from any device on the same network, at the same time.

**Customize (from the web UI)**
- One **Generation** panel for everything that goes into a run: **prompt** & **negative**, **size** (aspect ratio + megapixels, or exact width/height), **steps**, **CFG**, **sampler** and **scheduler**.
- **Seed** — set a fixed seed, roll a new random one, or randomize every run (works with the `Seed (rgthree)` node).
- **Reset to defaults** restores everything to the workflow defaults in one tap.

**Gallery actions**
- **Save image** / **Save all** (a `.zip` of the session).
- **Reuse settings** — reads the settings baked into a generated PNG and loads them back into the panel.
- **Copy prompt**, and an optional **Remove metadata** toggle so saved images don't carry your workflow.

**Nice to have**
- Clean iOS-style interface with **light & dark mode**.
- Smooth and snappy, with **image caching and preloading** so navigation is instant.
- Remote **Clear** and **Shutdown PC** controls.
- Images are **cleared automatically** on startup for a fresh session.

---

## Setup

### 1. Install

In your ComfyUI `custom_nodes` folder:

```
cd ComfyUI/custom_nodes/
git clone https://github.com/inxanedev/comfyui-lan-image-server.git
```

Then **restart ComfyUI**.

### 2. Start ComfyUI on your network

For other devices to connect, ComfyUI must listen on all interfaces (`0.0.0.0`). Launch it with:

```
python main.py --listen 0.0.0.0 --port 8000 --preview-method latent2rgb
```

> `--preview-method latent2rgb` (or `taesd`) is what enables the **Live Preview** tab.

### 3. Open the control panel

On any device connected to the same Wi-Fi, open:

```
http://<your-computer-ip>:8000/inx/view
```

The IP is also printed in the ComfyUI console the first time an image is served, for example:

```
[Serve Image on LAN] Image added to history (1)
 -> Access: http://192.168.1.20:8000/inx/view
```

> **First run:** queue a workflow once from ComfyUI so the panel learns the active workflow. After that you can drive it entirely from your phone.

---

## The Nodes (category: `inx`)

Double-click the canvas and search under the **`inx`** category.

### `Serve Image on LAN`
The core node — it streams images to the web panel.

- **Input:** `images` (IMAGE)
- **Output:** `images` (IMAGE) — passes the image straight through

**How to use it**
1. Connect your image (e.g. from **VAE Decode**) to its `images` input.
2. It shows a **preview right inside the node** (like *Preview Image*), so it can replace your existing preview node.
3. Because it passes the image through, you can **daisy-chain** it: `VAE Decode -> Serve Image on LAN -> Save Image`.

### `Fetch Generation Settings (LAN)`
One node that outputs all of the generation settings, which you then control from the web panel. Its input widgets are the **workflow defaults**; anything you change in the panel overrides them for the next run.

- **Outputs:** `text` (STRING), `negative` (STRING), `width` (INT), `height` (INT), `steps` (INT), `cfg` (FLOAT), `sampler_name`, `scheduler`
- **Inputs (defaults):** `default_text`, `default_negative`, `default_steps`, `default_cfg`, `default_sampler_name`, `default_scheduler`

**How to use it**
1. Set your defaults on the node (prompt, steps, etc.).
2. Wire the outputs:
   - `text` / `negative` → **CLIPTextEncode** (`text` input)
   - `width` / `height` → **Empty Latent Image**
   - `steps` / `cfg` / `sampler_name` / `scheduler` → **KSampler**
     *(for `sampler_name` and `scheduler`, right-click the KSampler widget → **Convert widget to input** first)*
3. Open the **Settings** tab to override any of them remotely. Resolution defaults to 1:1 at 1.5 MP and is configured in the panel.

> **Tip:** if you already have the values on your nodes, you can leave the defaults blank and just wire the outputs — the panel's values take over.

---

## Using the Web UI

The panel has three tabs: **Gallery**, **Live**, and **Settings**.

### Gallery
Browse every image generated this session. Use **Prev** / **Next** and the counter (e.g. `3 / 7`) — the buttons stretch across the bar for easy tapping. Pinch to zoom, drag to pan.

The **↓ button** on the right opens the gallery actions: **Save Image**, **Save All** (a `.zip`), **Reuse Settings**, **Copy Prompt**, and the **Remove metadata** toggle.

### Live
The real-time sampler preview, with the current **step counter** (e.g. `12 / 20`) in the corner. When a generation finishes it becomes the full-quality image, and the action bar here has **Run**, **Run (Instant)** / **Stop Loop**, and **Cancel**.

### Settings
An expandable list of sections — only one opens at a time. What you see depends on which `inx` nodes are in your workflow:

- **Generation** — appears with `Fetch Generation Settings (LAN)`. Edit the **prompt** and **negative**, the **size** (aspect ratio + megapixels, or tick **Custom** for exact pixels — with a live size preview such as `1000x1000 px`), plus **Steps**, **CFG**, **Sampler** and **Scheduler**. A **Reset to defaults** button clears everything. Changes save automatically and apply to the next run.
- **Seed (rgthree)** — appears only if a `Seed (rgthree)` node is in the workflow. Per node you can **Set** a fixed seed, roll a **New random** seed, switch to **Random each run**, or **Reset** to the workflow default.

At the bottom of the Settings tab: **Clear Images** (wipes the session gallery *and* resets your overrides) and **Shutdown PC**.

---

## Good to Know

- **Live preview needs a preview method.** Start ComfyUI with `--preview-method latent2rgb` or `taesd`.
- **Seed control is opt-in.** The Seed section only shows up when you use the [`Seed (rgthree)`](https://github.com/rgthree/rgthree-comfy) node. Other seed inputs are left untouched.
- **Run the workflow once from ComfyUI first** so the panel can capture it for remote runs.
- **Session images live in `temp/`** and are purged on startup, so every launch starts clean.
- **Only your changes are stored.** Anything you set to the node's default value is treated as "default" rather than an override, so the panel only carries what you actually changed.
- **`Reuse Settings` reads the PNG.** Each generated image embeds its prompt/workflow, so the panel can pull the prompt, size and seed back out of a good result (unless you saved it with metadata stripped).
- **The `Clear` button resets your remote settings too.** Along with the image gallery, it clears generation overrides and seed overrides back to their defaults so a fresh session can't leak settings into another workflow.
- **`Shutdown PC` really powers off the machine** (force-closing open apps). Use it deliberately.
- **No authentication.** Every `/inx/*` endpoint is open to anyone who can reach the address — they can run, cancel, clear, change settings, and **shut down the PC**. Keep it on a trusted LAN and **do not expose it to the internet** (no port forwarding, no public tunnels).

---

## License

No license, use it however you like. This whole thing including the README is vibe coded anyway :D
