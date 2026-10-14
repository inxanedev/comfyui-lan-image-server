# ComfyUI LAN Control Panel

Turn any phone, tablet, or computer on your Wi-Fi into a **remote control for ComfyUI**.

Watch generations happen live, start/stop runs, and tweak your prompt, seed, and resolution from the browser — no app, no account, no internet required. It started as a simple image viewer and grew into a lightweight control panel for ComfyUI over your local network.

---

## Highlights

**Watch**
- **Live preview** of the KSampler as it samples, step by step.
- **Seamless live-to-final**: the preview automatically swaps to the full-resolution finished image.
- **Session gallery** with `Prev` / `Next` and a counter, so you can flip back through everything generated this session.
- **Pinch-to-zoom & pan** on any image for inspecting details up close.

**Control**
- **Run** a workflow, or **Run (Instant)** to loop generation continuously.
- **Cancel** instantly to abort sampling and clear the queue.
- Works from any device on the same network, at the same time.

**Customize (from the web UI)**
- **Prompt / text** — swap the workflow prompt on the fly, or revert to the default.
- **Seed** — set a fixed seed, roll a new random one, or randomize every run (works with the `Seed (rgthree)` node).
- **Resolution** — pick an aspect ratio and megapixel budget, or type exact width/height.

**Nice to have**
- Clean iOS-style interface with **light & dark mode**.
- Smooth and snappy, with **image caching and preloading** so navigation is instant.
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

### `Serve Text on LAN`
Lets you edit a prompt remotely.

- **Input:** `default_text` (STRING) — your workflow's default prompt
- **Output:** `text` (STRING)

**How to use it**
1. Type your default prompt into `default_text` (or feed it from another string node).
2. Connect the `text` output to a **CLIPTextEncode** (or any other text input).

### `Serve Resolution on LAN`
Lets you change the output size remotely.

- **Outputs:** `width` (INT), `height` (INT)

**How to use it**
1. Connect `width` and `height` to the matching inputs on an **Empty Latent Image** (or any size input).
2. Configure the size from the **Resolution** section of the web UI (see below).

---

## Using the Web UI

The panel has three tabs: **Gallery**, **Live**, and **Settings**.

### Gallery
Browse every image generated this session. Use **Prev** / **Next** and the counter (e.g. `3 / 7`). Pinch to zoom, drag to pan.

### Live
The real-time sampler preview. When a generation finishes, it becomes the full-quality image.

### Settings
An expandable list of sections (only one opens at a time). What you see depends on which `inx` nodes are in your workflow:

- **Prompt** — edit the text served by `Serve Text on LAN`. **Save** applies it to the next run; **Revert to default** restores the workflow's original text.
- **Seed (rgthree)** — appears only if a `Seed (rgthree)` node is in the workflow. Per node you can **Set** a fixed seed, roll a **New random** seed, switch to **Random each run**, or **Reset** to the workflow default.
- **Resolution** — appears when `Serve Resolution on LAN` is in the workflow. Choose an **Aspect Ratio** (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9) and a **Megapixels** value (0.5–2.0), or tick **Custom** to type exact pixel dimensions. The **Preview** shows the resulting size (e.g. `1000x1000 px`).

### Action bar (always visible)
- **Run** — queue the workflow once.
- **Run (Instant)** — keep queuing as soon as each image finishes. Tap **Stop Loop** to stop after the current one.
- **Cancel** — abort the current generation and clear the queue.
- **Clear** — wipe the session gallery.

Any change you make in **Settings** is applied to the very next run automatically.

---

## Good to Know

- **Live preview needs a preview method.** Start ComfyUI with `--preview-method latent2rgb` or `taesd`.
- **Seed control is opt-in.** The Seed section only shows up when you use the [`Seed (rgthree)`](https://github.com/rgthree/rgthree-comfy) node. Other seed inputs are left untouched.
- **Run the workflow once from ComfyUI first** so the panel can capture it for remote runs.
- **Session images live in `temp/`** and are purged on startup, so every launch starts clean.
- **The `Clear` button resets your remote settings too.** Along with the image gallery, it clears the custom prompt, seed overrides, and resolution back to their defaults so a fresh session can't leak settings into another workflow.
- **No authentication.** Every `/inx/*` endpoint is open to anyone who can reach the address — they can run, cancel, clear, and change settings. Keep it on a trusted LAN and **do not expose it to the internet** (no port forwarding, no public tunnels).

---

## License

No license, use it however you like. This whole thing including the README is vibe coded anyway :D
