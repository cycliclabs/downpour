// Accounts + cloud sync (Supabase). Paste your project's values below.
const SUPABASE_URL = "https://btpzahserhjlzdmhgjvp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_gCDBQujMFh7TLaKhtGIyng_MlK-wkXI";  // Project Settings -> API -> anon public key

class CloudSync {
  static PREF_KEYS = ["focus-clock-font", "focus-background-image", "focus-background-video"];
  static LOCAL_AT = "focus-local-at";
  static EXCLUDE = ["active", "pomodoro"]; // per-device, never synced

  constructor(doc) {
    this.doc = doc;
    this.timer = null;
    this.lastPushed = null;
    this.user = null;
    this.configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
    this.el = {
      form: doc.getElementById("accountForm"),
      email: doc.getElementById("accountEmail"),
      password: doc.getElementById("accountPassword"),
      signIn: doc.getElementById("accountSignIn"),
      signUp: doc.getElementById("accountSignUp"),
      signOut: doc.getElementById("accountSignOut"),
      signedIn: doc.getElementById("accountSignedIn"),
      who: doc.getElementById("accountWho"),
      status: doc.getElementById("accountStatus")
    };
    window.addEventListener("focus-changed", () => this.touch());
    if (!this.configured) {
      this.say("Cloud sync isn't set up yet. Add your Supabase URL and anon key in cloud.js.", true);
      this.render();
      return;
    }
    this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    this.el.signIn.onclick = () => this.auth("signIn");
    this.el.signUp.onclick = () => this.auth("signUp");
    this.el.signOut.onclick = () => this.client.auth.signOut();
    this.el.form.onsubmit = e => { e.preventDefault(); this.auth("signIn"); };
    this.client.auth.onAuthStateChange((_event, session) => this.onSession(session));
    this.client.auth.getSession().then(({ data }) => this.onSession(data.session));
  }

  say(msg, isError = false) {
    this.el.status.textContent = msg;
    this.el.status.classList.toggle("is-error", isError);
  }

  render() {
    this.el.form.hidden = Boolean(this.user);
    this.el.signedIn.hidden = !this.user;
    if (this.user) this.el.who.textContent = this.user.email;
    [this.el.email, this.el.password, this.el.signIn, this.el.signUp].forEach(e => e.disabled = !this.configured);
  }

  async auth(kind) {
    const email = this.el.email.value.trim();
    const password = this.el.password.value;
    if (!email || password.length < 6) return this.say("Enter an email and a password of at least 6 characters.", true);
    this.say(kind === "signUp" ? "Creating account..." : "Signing in...");
    const { data, error } = await this.client.auth[kind === "signUp" ? "signUp" : "signInWithPassword"]({ email, password });
    if (error) return this.say(error.message, true);
    if (kind === "signUp" && !data.session) this.say("Check your email to confirm your account, then sign in.");
    this.el.password.value = "";
  }

  async onSession(session) {
    const user = session?.user ?? null;
    if (user?.id === this.user?.id) return;
    this.user = user;
    this.render();
    if (!user) { this.lastPushed = null; return this.say("Signed out. Your data stays on this device."); }
    await this.pull();
  }

  snapshot() {
    const state = JSON.parse(localStorage.getItem(FocusStore.KEY) || "{}");
    CloudSync.EXCLUDE.forEach(k => delete state[k]);
    const prefs = {};
    CloudSync.PREF_KEYS.forEach(k => { const v = localStorage.getItem(k); if (v != null) prefs[k] = v; });
    return { state, prefs };
  }

  // Sign-in: newer side wins. Remote newer -> apply it and reload; otherwise push local.
  async pull() {
    this.say("Syncing...");
    const { data, error } = await this.client.from("user_data").select("data, updated_at").maybeSingle();
    if (error) return this.say(`Sync failed: ${error.message}`, true);
    const localAt = Number(localStorage.getItem(CloudSync.LOCAL_AT) || 0);
    if (data && new Date(data.updated_at).getTime() > localAt) {
      const local = JSON.parse(localStorage.getItem(FocusStore.KEY) || "{}");
      const merged = { ...data.data.state };
      CloudSync.EXCLUDE.forEach(k => { if (k in local) merged[k] = local[k]; });
      localStorage.setItem(FocusStore.KEY, JSON.stringify(merged));
      CloudSync.PREF_KEYS.forEach(k => localStorage.removeItem(k));
      Object.entries(data.data.prefs || {}).forEach(([k, v]) => localStorage.setItem(k, v));
      localStorage.setItem(CloudSync.LOCAL_AT, String(new Date(data.updated_at).getTime()));
      return location.reload();
    }
    this.lastPushed = null;
    await this.push();
  }

  touch() {
    localStorage.setItem(CloudSync.LOCAL_AT, String(Date.now()));
    if (!this.user) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), 2000);
  }

  async push() {
    if (!this.user) return;
    const payload = this.snapshot();
    const json = JSON.stringify(payload);
    if (json === this.lastPushed) return this.say("Synced.");
    const at = new Date();
    const { error } = await this.client.from("user_data")
      .upsert({ user_id: this.user.id, data: payload, updated_at: at.toISOString() });
    if (error) return this.say(`Sync failed: ${error.message}`, true);
    this.lastPushed = json;
    localStorage.setItem(CloudSync.LOCAL_AT, String(at.getTime()));
    this.say(`Synced at ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
  }
}
