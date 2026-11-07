// Loading screen: the progress bar follows what really has to load (page, fonts, the chosen
// background image). It eases toward the real value, never jumps back, and fades out when done.
(() => {
  const loader = document.getElementById("loader");
  const fill = document.getElementById("loaderFill");
  const percent = document.getElementById("loaderPercent");
  if (!loader || !fill) return;

  const MIN_VISIBLE_MS = 700;      // avoid a flash on fast loads
  const GIVE_UP_MS = 10000;        // never trap the user behind the screen
  const started = performance.now();

  let backgroundSrc = "images/bg.jpg";
  try {
    const saved = localStorage.getItem("focus-background-image");
    if (saved && saved.startsWith("images/")) backgroundSrc = `images/${encodeURIComponent(saved.slice("images/".length))}`;
  } catch { /* storage blocked */ }

  const tasks = [
    new Promise(resolve => {                         // the background picture
      const image = new Image();
      image.onload = image.onerror = resolve;
      image.src = backgroundSrc;
    }),
    document.fonts?.ready ?? Promise.resolve(),      // web fonts
    new Promise(resolve => {                         // scripts, styles, icons
      if (document.readyState === "complete") resolve();
      else window.addEventListener("load", resolve, { once: true });
    })
  ];

  let finished = 0;
  tasks.forEach(task => Promise.resolve(task).catch(() => {}).then(() => { finished += 1; }));

  let shown = 0;
  let closing = false;
  const finish = () => {
    if (closing) return;
    closing = true;
    loader.classList.add("is-done");
    loader.setAttribute("aria-valuenow", "100");
    setTimeout(() => loader.remove(), 800);
  };

  const frame = now => {
    const elapsed = now - started;
    const allDone = finished === tasks.length || elapsed > GIVE_UP_MS;
    // real progress, plus a slow creep so the bar always looks alive; capped at 92% until everything is in
    const real = (finished / tasks.length) * 100;
    const target = allDone ? 100 : Math.min(92, Math.max(real, Math.min(80, elapsed / 40)));
    shown = Math.max(shown, shown + (target - shown) * 0.12);
    if (allDone && shown > 99.5) shown = 100;
    fill.style.width = `${shown}%`;
    if (percent) percent.textContent = `${Math.round(shown)}%`;
    loader.setAttribute("aria-valuenow", String(Math.round(shown)));
    if (shown >= 100 && elapsed >= MIN_VISIBLE_MS) return finish();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
