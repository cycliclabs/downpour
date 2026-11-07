// Accounts + cloud sync (Supabase). Paste your project's values below.
const SUPABASE_URL = "https://btpzahserhjlzdmhgjvp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_gCDBQujMFh7TLaKhtGIyng_MlK-wkXI";  // Project Settings -> API -> anon public key

class CloudSync {
  static PREF_KEYS = ["focus-clock-font", "focus-clock-format", "focus-alert-sound", "focus-background-image", "focus-background-video"];
  static USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
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
      username: doc.getElementById("accountUsername"),
      usernameSet: doc.getElementById("accountUsernameSet"),
      usernameInput: doc.getElementById("accountUsernameInput"),
      usernameSave: doc.getElementById("accountUsernameSave"),
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
    this.el.usernameSave.onclick = () => this.saveUsername();
    // Raindrop / streak chips open a leaderboard popover (see index.html); refresh it on every open.
    doc.querySelectorAll("[data-popover]").forEach(chip => chip.addEventListener("click", () => {
      const popover = doc.getElementById(chip.dataset.popover);
      if (!popover.hidden) this.loadLeaderboard(chip.dataset.popover === "streakPopover" ? "streak" : "raindrops");
    }));
    this.el.signIn.onclick = () => this.auth("signIn");
    this.el.signUp.onclick = () => this.auth("signUp");
    this.el.signOut.onclick = async () => {
      await this.client.auth.signOut({ scope: "local" });
      this.onSession(null);
    };
    this.el.form.onsubmit = e => { e.preventDefault(); this.auth("signIn"); };
    this.client.auth.onAuthStateChange((_event, session) => {
      // Never call supabase from inside this callback directly: it holds the auth lock and
      // would deadlock (which also blocks signOut). Defer to the next tick.
      setTimeout(() => this.onSession(session), 0);
    });
    this.client.auth.getSession().then(({ data }) => this.onSession(data.session));
  }

  say(msg, isError = false) {
    this.el.status.textContent = msg;
    this.el.status.classList.toggle("is-error", isError);
  }

  render() {
    this.el.form.hidden = Boolean(this.user);
    this.el.signedIn.hidden = !this.user;
    if (this.user) {
      const name = this.username();
      this.el.who.textContent = name ? `${name} · ${this.user.email}` : this.user.email;
      this.el.usernameSet.hidden = Boolean(name);   // accounts made before usernames existed can pick one here
    }
    [this.el.email, this.el.password, this.el.username, this.el.signIn, this.el.signUp].forEach(e => e.disabled = !this.configured);
  }

  username() {
    return this.user?.user_metadata?.username || "";
  }

  async usernameTaken(name) {
    const { data, error } = await this.client.rpc("username_available", { name });
    if (error) throw error;
    return data === false;
  }

  async auth(kind) {
    const email = this.el.email.value.trim();
    const password = this.el.password.value;
    const username = this.el.username.value.trim();
    if (!email || password.length < 6) return this.say("Enter an email and a password of at least 6 characters.", true);
    if (kind === "signUp") {
      if (!CloudSync.USERNAME_RE.test(username)) return this.say("Choose a username of 3-20 letters, numbers or underscores.", true);
      try {
        if (await this.usernameTaken(username)) return this.say("That username is taken. Try another.", true);
      } catch (error) { return this.say(`Couldn't check the username: ${error.message}`, true); }
    }
    this.say(kind === "signUp" ? "Creating account..." : "Signing in...");
    const credentials = kind === "signUp" ? { email, password, options: { data: { username } } } : { email, password };
    const { data, error } = await this.client.auth[kind === "signUp" ? "signUp" : "signInWithPassword"](credentials);
    if (error) return this.say(error.message, true);
    if (kind === "signUp" && !data.session) this.say("Check your email to confirm your account, then sign in.");
    this.el.password.value = "";
  }

  // Existing accounts without a username.
  async saveUsername() {
    const name = this.el.usernameInput.value.trim();
    if (!CloudSync.USERNAME_RE.test(name)) return this.say("Choose a username of 3-20 letters, numbers or underscores.", true);
    try {
      if (await this.usernameTaken(name)) return this.say("That username is taken. Try another.", true);
    } catch (error) { return this.say(`Couldn't check the username: ${error.message}`, true); }
    const { data, error } = await this.client.auth.updateUser({ data: { username: name } });
    if (error) return this.say(error.message, true);
    this.user = data.user;
    this.el.usernameInput.value = "";
    this.render();
    this.lastPushed = null;
    await this.push();
  }

  // ---- Leaderboards ------------------------------------------------------------------------
  currentStreak(state) {
    const { count = 0, lastDate = null } = state.streak || {};
    if (!lastDate) return 0;
    const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return lastDate === key(new Date()) || lastDate === key(yesterday) ? count : 0;
  }

  async loadLeaderboard(kind) {
    const host = this.doc.getElementById(kind === "streak" ? "streakBoard" : "raindropBoard");
    const note = text => { host.replaceChildren(Object.assign(this.doc.createElement("p"), { className: "settings-note", textContent: text })); };
    if (!this.configured) return note("Leaderboards need cloud sync to be set up.");
    if (!this.user) return note("Sign in (settings → Account) to see the leaderboard.");
    note("Loading...");
    const { data, error } = await this.client.from("profiles").select("user_id, username, raindrops, streak")
      .order(kind, { ascending: false }).order("username", { ascending: true }).limit(10);
    if (error) return note(`Couldn't load the leaderboard: ${error.message}`);
    if (!data.length) return note("No one is on the board yet.");
    const rows = data.map((row, index) => {
      const line = this.doc.createElement("div");
      line.className = "focus-goal-label leaderboard-row";
      if (row.user_id === this.user.id) line.classList.add("is-you");
      const name = this.doc.createElement("span");
      name.textContent = `${index + 1}. ${row.username}${row.user_id === this.user.id ? " (you)" : ""}`;
      const value = this.doc.createElement("span");
      value.textContent = String(row[kind]);
      line.append(name, value);
      return line;
    });
    host.replaceChildren(...rows);
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
    const username = this.username();
    if (username) {
      const { error: profileError } = await this.client.from("profiles").upsert({
        user_id: this.user.id,
        username,
        raindrops: Math.max(0, Math.floor(payload.state.raindrops || 0)),
        streak: this.currentStreak(payload.state),
        updated_at: at.toISOString()
      });
      if (profileError) return this.say(
        profileError.code === "23505" ? "That username is already taken." : `Leaderboard update failed: ${profileError.message}`, true);
    }
    this.lastPushed = json;
    localStorage.setItem(CloudSync.LOCAL_AT, String(at.getTime()));
    this.say(`Synced at ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
  }
}
