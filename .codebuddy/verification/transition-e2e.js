(async () => {
  const projectId = "71e2eb74-7aa9-4078-add0-9e8da2503e4a";
  if (location.pathname !== `/editor/${projectId}`) throw new Error("Wrong test project");
  const id = "transition-review-e2e";
  TURBOPACK.push(["transition-review-e2e.js", id, c => {
    window.__transitionReviewModules = Promise.all([
      c.i("[project]/suix/suix-project/opencut-classic/apps/web/src/core/index.ts [app-client] (ecmascript)"),
      c.i("[project]/suix/suix-project/opencut-classic/apps/web/src/editor/bridge/registry.ts [app-client] (ecmascript)")
    ]);
  }]);
  await TURBOPACK.push(["transition-review-e2e.js", { otherChunks: [], runtimeModuleIds: [id] }]);
  const [core, bridge] = await window.__transitionReviewModules;
  const editor = core.EditorCore.getInstance();
  if (editor.project.getActiveOrNull()?.metadata.id !== projectId) throw new Error("Wrong active project");
  if (editor.scenes.getActiveScene().tracks.main.elements.length) throw new Error("Test project must be empty");
  const bytes = Uint8Array.from(atob("__SOURCE_BASE64__"), x => x.charCodeAt(0));
  const file = new File([bytes], "transition-source.mp4", { type: "video/mp4" });
  const asset = await editor.media.addMediaAsset({ projectId, asset: {
    name: file.name, type: "video", file, url: URL.createObjectURL(file),
    duration: 4, width: 384, height: 216, fps: 30, hasAudio: true
  } });
  if (!asset) throw new Error("Cannot add test source");
  const run = (command, args = {}) => bridge.BRIDGE_COMMANDS[command].run({ editor, args });
  const trackId = editor.scenes.getActiveScene().tracks.main.id;
  const originalRipple = editor.command.isRippleEnabled;
  editor.command.isRippleEnabled = false;
  try {
    const first = await run("timeline.insert_element", {
      element: { type: "video", mediaId: asset.id, startTime: 0, duration: 4, name: "Hard cut source" },
      placement: { mode: "explicit", trackId }
    });
    await run("timeline.insert_element", {
      element: { type: "video", mediaId: asset.id, startTime: 4, duration: 4, name: "Following clip" },
      placement: { mode: "explicit", trackId }
    });
    await run("timeline.split_elements", { elements: [{ trackId, elementId: first.elementId }], splitTime: 2, retainSide: "both" });
    const geometry = () => editor.scenes.getActiveScene().tracks.main.elements.map(({ id, startTime, duration, trimStart, trimEnd, isSourceAudioEnabled }) => ({ id, startTime, duration, trimStart, trimEnd, isSourceAudioEnabled }));
    const before = JSON.stringify(geometry());
    const result = await run("code_render.apply", { mode: "transition", trackId, elementId: first.elementId, duration: 1, layout: "auto", code: `function render(ctx, {inputs, progress, width, height}) {
      ctx.drawImage(inputs[0], 0, 0, width, height);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(width/2, height/2);
      ctx.arc(width/2, height/2, Math.hypot(width, height), -Math.PI/2, -Math.PI/2 + progress*2*Math.PI);
      ctx.closePath(); ctx.clip();
      ctx.drawImage(inputs[1], 0, 0, width, height);
      ctx.restore();
    }` });
    if (before !== JSON.stringify(geometry())) throw new Error("Clip geometry or audio was changed");
    if (result.startTime !== 1.5 || result.endTime !== 2.5) throw new Error("Wrong transition window");
    const samples = [];
    for (const time of [1.4, 1.75, 2.25, 2.6]) {
      const frame = await run("preview.capture", { time });
      const image = new Image(); image.src = frame.dataUrl; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      let red = 0, blue = 0;
      for (let y = 5; y < canvas.height; y += 10) for (let x = 5; x < canvas.width; x += 10) {
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        if (r > 180 && b < 80) red++;
        if (b > 180 && r < 80) blue++;
      }
      samples.push({ time, red, blue });
    }
    if (!samples[0].red || samples[0].blue || !samples[3].blue || samples[3].red) throw new Error("Endpoint pixels are wrong");
    if (!samples[1].red || !samples[1].blue || !samples[2].red || !samples[2].blue) throw new Error("A/B frames were not combined");
    if (samples[2].blue <= samples[1].blue) throw new Error("Sweep does not reveal more B");
    window.__transitionReview = { editor, run, result, samples, geometry: geometry(), assetId: asset.id };
    await run("playback.seek", { time: 2.25 });
    return { result, samples, geometry: geometry(), sourceHasAudio: asset.hasAudio, mediaCount: editor.media.getAssets().length };
  } finally {
    editor.command.isRippleEnabled = originalRipple;
  }
})()
