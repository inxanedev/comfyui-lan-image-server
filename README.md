# ComfyUI LAN Image Server & Live Viewer

A custom node for ComfyUI that streams real-time KSampler step previews and serves full-resolution image history across your local area network (LAN) to any browser or mobile device.

---

## Features

- **Three-Tab Mobile Interface**: Designed with a responsive layout that fits mobile viewports (iOS & Android) perfectly with **Gallery**, **Live Preview**, and **Prompt** tabs.
- **Remote Workflow Execution**: Trigger workflow runs directly from your mobile device via the persistent **Run** and **Run (Instant)** buttons.
- **Run (Instant) Continuous Loop**: Keep generating in a continuous loop—tap "Stop Loop" or "Cancel" anytime to halt.
- **Instant Generation Cancel**: Abort running KSampler steps and clear pending queues on the fly with the **Cancel** button.
- **LAN Prompt / Text Customization**: View and edit prompts remotely from any connected device. Save customized prompts on the fly or revert back to the workflow default with a single tap.
- **Remote Seed Control (rgthree)** *(conditional)*: If your workflow uses the **`Seed (rgthree)`** node from [rgthree-comfy](https://github.com/rgthree/rgthree-comfy), a **Seed** panel appears in the **Prompt** tab, letting you set a fixed seed, roll a new fixed random seed, or switch to random-every-run. **This panel is only visible when a `Seed (rgthree)` node exists in the workflow—otherwise it stays completely hidden.**
- **Real-Time KSampler Live Preview**: Hooks directly into ComfyUI's core WebSocket stream (`send_bytes` / `send_image`) to parse and display `latent2rgb` preview frames frame-by-frame while sampling.
- **Pinch-to-Zoom & Pan**: On the **Gallery** and **Live Preview** tabs, pinch with two fingers to zoom in (up to 8x) and drag to pan around the image. Release to snap back to the original fit—handy for inspecting fine details on a phone.
- **Seamless Live-to-Final Transition**: When a workflow run finishes, the **Live Preview** tab automatically updates from the lossy KSampler preview to the full-resolution, VAE-decoded PNG image.
- **Session Gallery & Navigation**: Keeps track of all images generated during the current session with interactive `Prev` and `Next` buttons, a live counter (e.g., `1 / 4`), and state-aware auto-advancing (staying at the latest output unless manually navigating history).
- **Automated Session Cleanup**: Automatically purges temporary image files upon startup for a fresh slate every time ComfyUI launches.
- **Built-in Session Clear**: Clear image history and reset active browser connections directly from the web interface.

---

## Installation

1. Navigate to your ComfyUI `custom_nodes` directory:
   cd ComfyUI/custom_nodes/

2. Clone this repository:
   git clone https://github.com/inxanedev/comfyui-lan-image-server.git

3. Restart ComfyUI.

---

## How to Run & Requirements

To allow other devices on your local Wi-Fi or local network to connect, **ComfyUI must listen on all network interfaces** (`0.0.0.0`). 

Launch ComfyUI with the following command-line arguments:
python main.py --listen 0.0.0.0 --port 8000 --preview-method latent2rgb

> **Note:** You can also use `--preview-method taesd` instead of `latent2rgb`.

---

## Usage Guide

### 1. Remote Prompt Customization (`Serve Text on LAN`)
1. Double-click the ComfyUI canvas, search under the **`inx`** category, and add **`Serve Text on LAN`**.
2. Type your default prompt into `default_text` (or connect an existing string).
3. Connect the `text` output pin to `CLIPTextEncode` (or any node accepting text).
4. On your mobile or LAN browser (`/inx/view`), click the **Prompt** tab:
   - View the current workflow default.
   - Edit the multiline textbox and click **Save** to override with your custom prompt.
   - Click **Revert to default** at any time to clear the custom prompt and restore the workflow default.

### 2. Live Preview & Image Gallery (`Serve Image on LAN`)
1. Add the **`Serve Image on LAN`** node (under **`inx`** category).
2. Connect any image output (e.g., from a VAE Decode node) to the **`Serve Image on LAN`** node's `images` input.
3. Run the workflow once from ComfyUI to activate the LAN session. Your terminal console will print the local network address:
   [Serve Image on LAN] Image added to history (1)
   -> Access: http://192.168.x.x:8000/inx/view

4. Open `http://<your-pc-ip>:8000/inx/view` in any desktop or mobile browser connected to the same Wi-Fi network.

### 3. Remote Control: Run, Run (Instant) Loop & Cancel
Once a workflow has been run at least once in ComfyUI, the bottom action bar allows you to trigger and control generation directly from the web interface across all tabs:
- **Run**: Triggers execution of the active workflow as configured.
- **Run (Instant)**: Enters a continuous loop that automatically queues the next generation as soon as each image is saved. While looping, the button turns into a pulsing **Stop Loop** button to cleanly finish after the current run.
- **Cancel**: Immediately halts the current generation via ComfyUI's interrupt mechanism and wipes any queued prompts.

### 4. Remote Seed Control (`Seed (rgthree)`)
> **Important:** This feature **only** works if your workflow uses the **`Seed (rgthree)`** node. If no `Seed (rgthree)` node is present, the Seed panel is **not rendered at all**—the Prompt tab looks exactly as before.

1. Add the **`Seed (rgthree)`** node (from rgthree-comfy) to your workflow and connect its `SEED` output to your sampler's seed input.
2. Run the workflow once from ComfyUI so the node is captured in the active prompt.
3. On the LAN interface (`/inx/view`), open the **Prompt** tab. A **Seed (rgthree)** panel appears below the prompt editor, listing every seed node in the workflow by its title.
4. Per node, use:
   - **Set** — lock in the number currently in the field as a fixed seed.
   - **New random** — generate a new random seed once and keep using it.
   - **Random each run** — a new random seed on every generation (equivalent to `-1`).
   - **Reset** — remove the override and fall back to the workflow's default seed.

Only `Seed (rgthree)` nodes are ever targeted; every other node (including standard samplers) is left untouched.

## How It Works

### Backend (`lan_image_server.py`)
- **Web Routes**: Registers custom AIOHTTP server routes directly onto ComfyUI's native `PromptServer` (`/inx/view`, `/inx/image`, `/inx/ws`, `/inx/text`, `/inx/revert_text`, `/inx/seed`, `/inx/kill_server`), plus `/inx/ui/{filename}` which serves the frontend assets.
- **External Frontend Assets**: The client is split into `ui/index.html`, `ui/style.css`, and `ui/script.js`, served from the `ui/` folder instead of being embedded in the script.
- **Binary Stream Interception**: Hooks into `PromptServer.instance.send_bytes` to capture KSampler step preview frames as they are generated on the server backend.
- **Broadcast System**: Relays binary preview frames, session updates, and live prompt changes across custom WebSocket connections (`/inx/ws`) to all active LAN clients simultaneously.
- **Seed Override Patching**: On each remote run, the active prompt is scanned for `Seed (rgthree)` nodes and only those nodes have their `seed` input patched from the active overrides before queueing. A capture-skip flag keeps the original workflow seed intact so "Reset" always restores the true default.

### Frontend Client (`/inx/view`)
- **Interactive Tabs**: Seamlessly toggle between **Gallery**, **Live Preview**, and **Prompt** editor.
- **Conditional Seed Panel**: The Prompt tab renders a **Seed** control panel only when a `Seed (rgthree)` node is detected in the workflow, leaving the UI unchanged for workflows that don't use it.
- **Magic Byte Scanning**: Intercepts incoming WebSocket binary ArrayBuffers and scans for standard **JPEG (`0xFF, 0xD8`)** or **PNG (`0x89, 'P', 'N', 'G'`)** magic header bytes. This dynamically strips out ComfyUI's internal JSON metadata prefixes, ensuring raw, valid image blobs are constructed reliably across mobile browsers.
- **Memory Management**: Uses `URL.createObjectURL()` for instant image rendering and automatically calls `URL.revokeObjectURL()` to prevent client-side browser memory leaks during extended generation sessions.

---

## License

No license, use it however you like. This whole thing including the README is vibe coded anyway :D