class FocusStore {
  static KEY = "focus-app-v1";

  static defaultState() {
    return {
      categories: [
        { id: "school", name: "School", color: "#6c63ff" },
        { id: "coding", name: "Coding", color: "#19a974" },
        { id: "hobby", name: "Hobby", color: "#f59e0b" }
      ],
      tasks: [],
      active: null,
      brainDump: "",
      dailyTarget: null,
      pomodoro: null,
      pomodoroSettings: { focusMinutes: 25, breakMinutes: 5 },
      raindrops: 0,                              // currency earned by completing tasks (see FocusApp.RAINDROPS)
      streak: { count: 0, lastDate: null }       // consecutive days with at least one completed task
    };
  }

  constructor() {
    this.state = this.load();
  }

  load() {
    const stored = localStorage.getItem(FocusStore.KEY);
    const defaults = FocusStore.defaultState();
    if (!stored) return defaults;

    const saved = JSON.parse(stored);
    const savedPomodoroSettings = saved.pomodoroSettings && typeof saved.pomodoroSettings === "object"
      ? saved.pomodoroSettings
      : {};
    return {
      ...defaults,
      ...saved,
      pomodoroSettings: { ...defaults.pomodoroSettings, ...savedPomodoroSettings },
      streak: { ...defaults.streak, ...(saved.streak && typeof saved.streak === "object" ? saved.streak : {}) }
    };
  }

  save() {
    localStorage.setItem(FocusStore.KEY, JSON.stringify(this.state));
    window.dispatchEvent(new Event("focus-changed"));
  }

  addTask(task) {
    this.state.tasks.push(task);
    this.save();
  }

  addCategory(category) {
    this.state.categories.push(category);
    this.save();
  }

  findTask(id) {
    return this.state.tasks.find(task => task.id === id);
  }
}

class FocusApp {
  // Backgrounds. Every image in ./images becomes a choice in settings, named after its file
  // (extension removed). Files come from three places, in this order of preference:
  //   1. images/backgrounds.json, written by update-backgrounds.py (works on any host)
  //   2. the folder listing, when served with one (`python -m http.server`, VS Code Live Server)
  //   3. BUNDLED_BACKGROUND_FILES below (fallback, e.g. file://)
  // Images uploaded in settings are stored in this browser (IndexedDB) and listed after them.
  static BUNDLED_BACKGROUND_FILES = ["bg.jpg", "bg2.jpg", "bg3.jpg", "bg4.jpg", "bg5.jpg"];
  static BACKGROUND_EXT = /\.(?:jpe?g|png|webp|avif|gif)$/i;
  static BACKGROUND_DB = "focus-backgrounds";
  // Clock fonts. Every font file in ./fonts becomes a choice in settings, named after its file
  // (extension removed; "-Bold", "-Regular", "-VariableFont_wght" and similar endings are dropped
  // so the weights of one family group together). Files come from three places:
  //   1. fonts/fonts.json, written by update-lists.py (works on any host)
  //   2. the folder listing, when served with one (`python -m http.server`, VS Code Live Server)
  //   3. BUNDLED_FONT_FILES below (fallback, e.g. file://)
  static FONT_EXT = /\.(?:ttf|otf|woff2?)$/i;
  static BUNDLED_FONT_FILES = [
    "Jost-VariableFont_wght.ttf",
    "Audiowide-Regular.ttf",
    "Cinzel-VariableFont_wght.ttf",
    "NationalPark-VariableFont_wght.ttf",
    "Unkempt-Bold.ttf"
  ];
  static DEFAULT_CLOCK_FONT = "Jost";
  // Raindrops are awarded when a task is checked off, by comparing the focused time with the estimate:
  //   ratio < onTargetBand[0]        faster than estimated  -> `faster` (a lot faster pays the same)
  //   within onTargetBand            on target              -> `base`
  //   ratio > onTargetBand[1]        slower than estimated  -> `slower`
  // A task needs an estimate and at least `minFocusMs` of focus to pay out, and pays out once.
  static RAINDROPS = { base: 10, faster: 12, slower: 8, onTargetBand: [0.9, 1.1], minFocusMs: 60 * 1000 };
  static ETA_PRESETS = [15, 25, 45, 60, 90, 120];   // minutes offered when a task is started
  static CELEBRATION_MS = 6000;
  static POMODORO_WORK_MS = 25 * 60 * 1000;
  static POMODORO_BREAK_MS = 5 * 60 * 1000;

  constructor(document, store = new FocusStore()) {
    this.document = document;
    this.store = store;
    this.askForDailyTarget();
    this.selectedDate = this.today();
    this.selectedActivityYear = new Date().getFullYear();
    this.selectedActivityRange = "daily";
    const [year, month] = this.selectedDate.split("-").map(Number);
    this.calendarMonth = new Date(year, month - 1, 1);
    this.selectedCategory = "all";
    this.editingTaskId = null;
    this.expandedTaskId = null;
    this.lastCalendarMinute = null;
    this.lastFocusTaskDate = this.today();
    this.calendarAutoScrollPending = true;
    this.audioContext = null;
    this.countdown = null;
    this.countdownInterval = null;
    this.totalActiveFocusMs = 0;
    this.lastActiveTick = null;
    this.checkInActive = false;
    this.checkInDeadline = null;
    this.etaPrompt = null;
    this.celebrationTimer = null;
    this.elements = this.getElements();
    this.folderBackgrounds = FocusApp.BUNDLED_BACKGROUND_FILES.map(name => this.folderBackground(name));
    this.backgrounds = [...this.folderBackgrounds];
    this.customBackgroundUrls = new Map();
    this.renderBackgroundChoices();
    this.selectedActivityCategory = "all";
    this.selectedTrendCategories = [];
    this.selectedCategory = "all";
    this.hideCompleted = false;
    const savedBackground = localStorage.getItem("focus-background-image");
    if (savedBackground?.startsWith("images/") && !this.backgrounds.some(bg => bg.id === savedBackground)) {
      this.backgrounds.push(this.folderBackground(savedBackground.slice("images/".length)));   // apply at once; the folder scan below confirms it
    }
    if (!savedBackground?.startsWith("custom:")) {
      this.setBackgroundImage(this.backgrounds.some(bg => bg.id === savedBackground) ? savedBackground : this.backgrounds[0].id, false);
    }
    this.loadBackgrounds();                        // finds the folder's images and the uploaded ones, then re-applies the choice
    const savedVideo = localStorage.getItem("focus-background-video");
    if (savedVideo) this.setBackgroundVideo(savedVideo, false);
    this.clockFonts = new Map();
    this.clockFont = localStorage.getItem("focus-clock-font") || FocusApp.DEFAULT_CLOCK_FONT;
    this.setClockFont(this.clockFont, false);      // applies at once; the list below fills in asynchronously
    this.loadClockFonts();
    this.bindEvents();
    this.render();
    window.setInterval(() => {
      const now = Date.now();

      // --- Active Focus Time Tracking ---
      const isActivelyFocusing = this.store.state.active && 
                                 !this.store.state.pomodoro?.paused && 
                                 this.store.state.pomodoro?.phase !== "break" && 
                                 !this.checkInActive &&
                                 !this.countdown; // Don't count during the 3-2-1 countdown

      if (isActivelyFocusing) {
        if (!this.lastActiveTick) this.lastActiveTick = now;
        this.totalActiveFocusMs += (now - this.lastActiveTick);
        this.lastActiveTick = now;

        // Trigger prompt at exactly 1 hour (60 * 60 * 1000) of focus
        if (this.totalActiveFocusMs >= 60 * 60 * 1000) {
          this.openCheckIn();
        }
      } else {
        this.lastActiveTick = null; // Pause the tracker if not actively focusing
      }

      // --- Check-in Countdown ---
      if (this.checkInActive) {
        const remaining = Math.max(0, Math.ceil((this.checkInDeadline - now) / 1000));
        if (remaining <= 0) {
          this.checkInTimeout();
          return; // Stop processing further renders this tick, task is stopping
        } else {
          this.elements.checkinCountdown.textContent = remaining;
        }
      }
      const phaseChanged = this.advancePomodoro(Date.now());
      if (phaseChanged) {
        this.render();
        return;
      }
      this.renderClock();
      this.renderPomodoro();
      this.renderLiveTimers();
      this.renderFocusSummary();
      this.renderAnalyticsWidgets();
      if (this.lastFocusTaskDate !== this.today()) {
        this.lastFocusTaskDate = this.today();
        this.renderTasks();
      }
      if (Math.floor(Date.now() / 60000) !== this.lastCalendarMinute) {
        this.renderCalendar();
        this.renderActivityCalendar();
      }
    }, 1000);
  }

  getElements() {
    const query = selector => this.document.querySelector(selector);
    return {
      clock: query("#clock"),
      liveTime: query("#liveTime"),
      taskPlanner: query("#taskPlanner"),
      taskPlannerMonth: query("#taskPlannerMonth"),
      taskPlannerGrid: query("#taskPlannerGrid"),
      fullscreenButton: query("#fullscreenButton"),
      focusNowWidget: query("#focusNowWidget"),
      focusNowTask: query("#focusNowTask"),
      timeLine: query("#timeLine"),
      backgroundChoices: query("#backgroundChoices"),
      backgroundUploadInput: query("#backgroundUploadInput"),
      backgroundUploadStatus: query("#backgroundUploadStatus"),
      newCategoryName: query("#newCategoryName"),
      analyticsWidgets: query("#analyticsWidgets"),
      backgroundVideoUrl: query("#backgroundVideoUrl"),
      backgroundVideoBtn: query("#backgroundVideoBtn"),
      backgroundVideoClear: query("#backgroundVideoClear"),
      backgroundVideoStatus: query("#backgroundVideoStatus"),
      clockFontChoices: query("#clockFontChoices"),
      categoryFilter: query("#categoryFilter"),
      taskSelectedDate: query("#taskSelectedDate"),
      categoryEditor: query("#categoryEditor"),
      tasks: query("#tasks"),
      focusTotal: query("#focusTotal"),
      focusProgress: query("#focusProgress"),
      activityMonths: query("#activityMonths"),
      activityGrid: query("#activityGrid"),
      activityLegend: query(".activity-legend"),
      activityCard: query("#focusActivity"),
      activityYear: query("#activityYear"),
      activityTrendRange: query("#activityTrendRange"),
      activityTrendChart: query("#activityTrendChart"),
      focusSelectedDate: query("#focusSelectedDate"),
      pomodoroPhase: query("#pomodoroPhase"),
      pomodoroSettings: query("#pomodoroSettings"),
      pomodoroFocusMinutes: query("#pomodoroFocusMinutes"),
      pomodoroBreakMinutes: query("#pomodoroBreakMinutes"),
      pomodoroReset: query("#pomodoroReset"),
      centerStage: query("#centerStage"),
      pomodoroControls: query("#pomodoroControls"),
      calendarDate: query("#calendarDate"),
      calendarScroll: query("#calendarScroll"),
      taskCalendar: query("#taskCalendar"),
      brainDump: query("#brainDump"),
      brainDumpPanel: query("#brainDumpPanel"),
      brainDumpToggle: query("#brainDumpToggle"),
      brainDumpClose: query("#brainDumpClose"),
      hideCompletedToggle: query("#hideCompletedToggle"),
      pageViews: this.document.querySelectorAll(".page-view[data-page-view]"),
      pomodoroPipButton: query("#pomodoroPipButton"),
      focusIdleWidget: query("#focusIdleWidget"),
      focusTasksDropdown: query("#focusTasksDropdown"),
      focusTasksToggle: query("#focusTasksToggle"),
      focusTasksList: query("#focusTasksList"),
      focusTasksCount: query("#focusTasksCount"),
      focusAddTaskBtn: query("#focusAddTaskBtn"),

      settingsButton: query("#settingsButton"),
      settingsPanel: query("#settingsPanel"),
      settingsBackdrop: query("#settingsBackdrop"),
      closeSettings: query("#closeSettings"),

      countdownDisplay: query("#countdownDisplay"),
      countdownValue: query("#countdownValue"),
      checkinDisplay: query("#checkinDisplay"),
      checkinCountdown: query("#checkinCountdown"),
      checkinConfirm: query("#checkinConfirm"),
      etaDisplay: query("#etaDisplay"),
      etaTaskName: query("#etaTaskName"),
      etaChips: query("#etaChips"),
      etaForm: query("#etaForm"),
      etaMinutes: query("#etaMinutes"),
      etaSkip: query("#etaSkip"),
      etaCancel: query("#etaCancel"),
      celebrateDisplay: query("#celebrateDisplay"),
      celebrateTitle: query("#celebrateTitle"),
      celebrateCompare: query("#celebrateCompare"),
      celebrateDrops: query("#celebrateDrops"),
      celebrateStreak: query("#celebrateStreak"),
      raindropCount: query("#raindropCount"),
      streakCount: query("#streakCount"),
      streakChip: query("#streakChip"),

      focusMusicToggle: query("#focusMusicToggle"),
      focusMusicPanel: query("#focusMusicPanel"),
      musicClose: query("#musicClose"),

      activityCategoryFilter: query("#activityCategoryFilter"),
      trendMultiSelect: query("#trendMultiSelect"),
      trendMultiBtn: query("#trendMultiBtn"),
      trendMultiCount: query("#trendMultiCount"),
      trendMultiContent: query("#trendMultiContent"),
    };
  }

  // Sizes the clock so its digits are exactly as wide as the bar under it (70 stage units).
  // The ratio is independent of the unit, so one scale works on the page and in PiP.
  fitClock() {
    const stage = this.elements.centerStage;
    const clock = this.elements.clock;
    const width = clock.getBoundingClientRect().width;
    if (!width) return;                              // page hidden
    const current = parseFloat(stage.style.getPropertyValue("--clock-scale")) || 20;
    const unit = parseFloat(getComputedStyle(clock).fontSize) / current;
    const next = Math.min(26, Math.max(8, current * 70 * unit / width));   // max keeps the column inside the stage
    if (Math.abs(next - current) > 0.05) stage.style.setProperty("--clock-scale", next.toFixed(2));
  }

  bindEvents() {
    new ResizeObserver(() => this.fitClock()).observe(this.elements.clock);
    this.document.addEventListener("pointerdown", () => this.unlockAudio(), { once: true });
    this.document.addEventListener("fullscreenchange", () => this.updateFullscreenButtonState());
    this.document.addEventListener("webkitfullscreenchange", () => this.updateFullscreenButtonState());

    this.document.querySelector("#addTask").onclick = () => this.openNewTaskModal();
    
    // The new "+ Task" button inside the dropdown
    this.elements.focusAddTaskBtn.onclick = () => this.openNewTaskModal();

    // Logic to open/close the dropdown when clicking the header
    this.elements.focusTasksToggle.onclick = (e) => {
      e.stopPropagation(); // Prevents the document-level click listener from immediately closing it
      const dropdown = this.elements.focusTasksDropdown;
      const isOpen = dropdown.classList.toggle("is-open");
      this.elements.focusTasksToggle.setAttribute("aria-expanded", String(isOpen));
    };

    // raindrop / streak popovers
    const popoverChips = [...this.document.querySelectorAll("[data-popover]")];
    const closePopovers = () => popoverChips.forEach(chip => {
      this.document.getElementById(chip.dataset.popover).hidden = true;
      chip.setAttribute("aria-expanded", "false");
    });
    popoverChips.forEach(chip => chip.addEventListener("click", event => {
      event.stopPropagation();
      const popover = this.document.getElementById(chip.dataset.popover);
      const open = popover.hidden;
      closePopovers();
      popover.hidden = !open;
      chip.setAttribute("aria-expanded", String(open));
    }));
    this.document.addEventListener("click", event => { if (!event.target.closest(".stat-popover")) closePopovers(); });
    this.document.addEventListener("keydown", event => { if (event.key === "Escape") closePopovers(); });

    this.document.querySelector("#addCat").onclick = () => this.addCategory();
    this.elements.newCategoryName.onkeydown = event => { if (event.key === "Enter") this.addCategory(); };
    this.elements.fullscreenButton.onclick = () => this.toggleFullscreen();
    this.elements.pomodoroPipButton.onclick = () => this.toggleDocumentPiP();
    this.elements.clockFontChoices.onclick = event => {
      const choice = event.target.closest("[data-font]");
      if (choice) this.setClockFont(choice.dataset.font);
    };
    this.elements.backgroundUploadInput.onchange = () => this.addCustomBackground();
    this.elements.backgroundChoices.onclick = event => {
      if (event.target.closest("[data-background-add]")) return this.elements.backgroundUploadInput.click();
      const remove = event.target.closest("[data-background-delete]");
      if (remove) return this.deleteCustomBackground(remove.dataset.backgroundDelete);
      const choice = event.target.closest("[data-background]");
      if (!choice) return;
      this.setBackgroundVideo(null);              // one background at a time: a picture replaces the video
      this.setBackgroundImage(choice.dataset.background);
    };
    this.elements.backgroundVideoBtn.onclick = () => this.applyBackgroundVideoInput();
    this.elements.backgroundVideoUrl.onkeydown = event => {
      if (event.key === "Enter") this.applyBackgroundVideoInput();
    };
    this.elements.backgroundVideoClear.onclick = () => this.setBackgroundVideo(null);

    this.elements.activityCategoryFilter.onchange = (e) => {
      this.selectedActivityCategory = e.target.value;
      this.renderActivityCalendar();
    };

    // Trend Multi-select Dropdown
    this.elements.trendMultiBtn.onclick = (e) => {
      e.stopPropagation();
      this.elements.trendMultiSelect.classList.toggle("is-open");
    };


    this.document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      
      const modal = this.document.getElementById("taskModal");
      if (modal && !modal.hidden) {
        this.closeTaskModal();
        return;
      }
      if (this.elements.settingsPanel.classList.contains("is-open")) {
        this.closeSettings();
        return;
      }
      if (this.elements.brainDumpPanel.classList.contains("is-open")) {
        this.collapseBrainDump();
        return;
      }
      if (this.elements.focusMusicPanel.classList.contains("is-open")) {
        this.collapseMusicPanel();
        return;
      }
    });

    this.document.addEventListener("click", event => {
      // Close Brain Dump
      if (this.elements.brainDumpPanel.classList.contains("is-open")) {
        if (!this.elements.brainDumpPanel.contains(event.target)) {
          this.collapseBrainDump();
        }
      }

      // Close Focus Music
      if (this.elements.focusMusicPanel.classList.contains("is-open")) {
        if (!this.elements.focusMusicPanel.contains(event.target)) {
          this.collapseMusicPanel();
        }
      }

      if (this.elements.trendMultiSelect.classList.contains("is-open") && !this.elements.trendMultiSelect.contains(event.target)) {
        this.elements.trendMultiSelect.classList.remove("is-open");
      }

      // Close Tasks Dropdown
      if (!this.elements.focusTasksDropdown.contains(event.target)) this.closeFocusTasks();

      // Close Task Modal / Inline Details
      const modal = this.document.getElementById("taskModal");
      if (modal && !modal.hidden) {
        if (event.target === modal) {
          this.closeTaskModal();
        }
      } else {
        if (!event.target.closest(".task-row")) {
          this.document.querySelectorAll(".task-row.is-expanded").forEach(row => {
            row.classList.remove("is-expanded");
            const details = row.querySelector(".task-details");
            if (details) details.hidden = true;
          });
          this.expandedTaskId = null;
        }
      }
    });


    // --- Music Panel Logic ---
    this.elements.focusMusicToggle.onclick = () => this.toggleMusicPanel();
    this.elements.musicClose.onclick = () => this.collapseMusicPanel();

    // Tab Switching
    this.document.querySelectorAll(".music-tab").forEach(tab => {
      tab.onclick = () => {
        this.document.querySelectorAll(".music-tab").forEach(t => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        
        const target = tab.dataset.tab;
        this.document.getElementById("tab-ambient").hidden = target !== "ambient";
        this.document.getElementById("tab-playlists").hidden = target !== "playlists";
      };
    });

    // Ambient Sounds Toggle (Visual only for now)
    this.document.querySelectorAll(".sound-btn").forEach(btn => {
      btn.onclick = () => btn.classList.toggle("is-active");
    });

    // Spotify Loader
    this.document.getElementById("spotifyAddBtn").onclick = () => {
      const input = this.document.getElementById("spotifyUrlInput").value;
      const container = this.document.getElementById("spotifyEmbedContainer");
      
      // Extract the type (playlist, album, track) and ID from the URL
      const match = input.match(/spotify\.com\/(playlist|album|track)\/([a-zA-Z0-9]+)/);
      
      if (match && match[1] && match[2]) {
        const type = match[1];
        const id = match[2];
        container.innerHTML = `<iframe src="https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
        this.document.getElementById("spotifyUrlInput").value = ""; // Clear input
      } else {
        container.innerHTML = `<div class="spotify-empty" style="color:#ff5c5c">Invalid Spotify URL. Please paste a valid link.</div>`;
      }
    };





    this.elements.pomodoroSettings.onsubmit = event => {
      event.preventDefault();
      this.savePomodoroSettings();
    };
    this.elements.pomodoroReset.onclick = () => this.resetPomodoro();
    this.elements.taskPlanner.onclick = event => {
      const monthButton = event.target.closest("[data-month-offset]");
      if (monthButton) {
        this.changeCalendarMonth(Number(monthButton.dataset.monthOffset));
        return;
      }
      const day = event.target.closest("[data-drop-date]");
      if (day) this.selectPlannerDate(day.dataset.dropDate);
    };
    this.elements.taskPlanner.onkeydown = event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const day = event.target.closest(".task-planner-day[data-drop-date]");
      if (!day) return;
      event.preventDefault();
      this.selectPlannerDate(day.dataset.dropDate);
    };
    this.elements.taskPlanner.ondragstart = event => {
      const task = event.target.closest("[data-task-id][draggable='true']");
      if (task) this.beginTaskDrag(event, task.dataset.taskId, task);
    };
    this.elements.taskPlanner.ondragend = event => {
      const task = event.target.closest("[data-task-id][draggable='true']");
      if (task) task.classList.remove("is-dragging");
      this.elements.taskPlannerGrid.querySelectorAll(".is-drop-target").forEach(day => day.classList.remove("is-drop-target"));
    };
    this.elements.taskPlanner.ondragover = event => {
      const day = event.target.closest("[data-drop-date]");
      if (!day) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      day.classList.add("is-drop-target");
    };
    this.elements.taskPlanner.ondragleave = event => {
      const day = event.target.closest("[data-drop-date]");
      if (day && !day.contains(event.relatedTarget)) day.classList.remove("is-drop-target");
    };
    this.elements.taskPlanner.ondrop = event => {
      const day = event.target.closest("[data-drop-date]");
      if (!day) return;
      event.preventDefault();
      day.classList.remove("is-drop-target");
      const taskId = event.dataTransfer?.getData("text/plain");
      if (taskId) this.scheduleTask(taskId, day.dataset.dropDate);
    };
    this.elements.brainDumpToggle.onclick = () => this.toggleBrainDump();
    this.elements.brainDumpClose.onclick = () => this.collapseBrainDump();

    this.elements.settingsButton.onclick = () => this.openSettings();
    this.elements.closeSettings.onclick = () => this.closeSettings();
    this.elements.settingsBackdrop.onclick = () => this.closeSettings();

    // --- NEW: Settings Sidebar Navigation ---
    const settingsNavItems = this.document.querySelectorAll(".settings-nav-item");
    const settingsTabs = this.document.querySelectorAll(".settings-tab");

    settingsNavItems.forEach(item => {
      item.onclick = () => {
        // Remove active class from all nav items
        settingsNavItems.forEach(nav => nav.classList.remove("is-active"));
        // Add active class to clicked item
        item.classList.add("is-active");

        // Hide all tabs
        settingsTabs.forEach(tab => tab.hidden = true);
        // Show the matching tab
        const targetTab = this.document.getElementById(`tab-${item.dataset.settingsTab}`);
        if (targetTab) targetTab.hidden = false;
      };
    });

    this.document.addEventListener("click", event => {
          const button = event.target.closest(".page-nav-button[data-page]");
          if (button) {
            this.setPage(button.dataset.page);
          }
        });
    this.elements.brainDump.oninput = event => {
      this.store.state.brainDump = event.target.value;
      this.store.save();
    };
    this.elements.hideCompletedToggle.onchange = () => {
      this.hideCompleted = this.elements.hideCompletedToggle.checked;
      this.renderTasks();
    };
    this.elements.checkinConfirm.onclick = () => this.confirmCheckIn();
    this.elements.etaChips.innerHTML = FocusApp.ETA_PRESETS.map(minutes =>
      `<button class="ui-control" type="button" data-minutes="${minutes}">${minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}</button>`).join("");
    this.elements.etaChips.onclick = event => {
      const chip = event.target.closest("[data-minutes]");
      if (chip) this.chooseEta(Number(chip.dataset.minutes));
    };
    this.elements.etaForm.onsubmit = event => {
      event.preventDefault();
      const minutes = Number(this.elements.etaMinutes.value);
      if (Number.isFinite(minutes) && minutes >= 1) this.chooseEta(Math.min(1440, Math.round(minutes)));
      else this.elements.etaMinutes.focus();
    };
    this.elements.etaSkip.onclick = () => this.chooseEta(null);
    this.elements.etaCancel.onclick = () => this.closeEtaPrompt();
    this.elements.celebrateDisplay.onclick = () => this.dismissCelebration();
    this.document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (this.etaPrompt) this.closeEtaPrompt();
      else this.dismissCelebration();
    });
  }

  setPage(page) {
      if (!["focus", "analytics", "tasks"].includes(page)) return;

      this.document.body.dataset.page = page;
      this.elements.pageViews.forEach(view => {
        view.hidden = view.dataset.pageView !== page;
      });
      
      this.document.querySelectorAll("[data-page]").forEach(button => {
        const isActive = button.dataset.page === page;
        button.classList.toggle("is-active", isActive);
        if (isActive) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      this.renderAnalyticsWidgets();
    }
  
  closeTaskModal() {
    const modal = this.document.getElementById("taskModal");
    if (!modal || modal.hidden) return;

    const details = modal.querySelector(".task-details");
    
    if (details && this.activeTaskRow) {
      this.activeTaskRow.appendChild(details);
      details.hidden = true;
      this.activeTaskRow.classList.remove("is-expanded");
    }

    modal.innerHTML = "";
    modal.hidden = true;
    this.expandedTaskId = null;
    this.activeTaskRow = null;
    
    // This forces the tasks to re-render from the store, wiping any unsaved edits
    this.render(); 
  }

  openNewTaskModal() {
    this.closeTaskModal(); // Ensure any open task is closed
    
    const modal = this.document.getElementById("taskModal");
    
    // Create a dummy task object just for the markup
    const dummyTask = {
      id: "new-task",
      name: "",
      category: this.store.state.categories[0]?.id || "",
      priority: "medium",
      date: this.selectedDate || this.today(),
      created: Date.now(),
      sessions: [],
      done: false
    };
    
    modal.innerHTML = `<div class="task-details">${this.taskDetailsMarkup(dummyTask, true)}</div>`;
    modal.hidden = false;
    
    const details = modal.querySelector(".task-details");
    this.bindTaskDetailsEvents(details, null, true);
    
    // Focus the name input automatically
    setTimeout(() => details.querySelector(".task-detail-name")?.focus(), 50);
  }

  openSettings() {
    this.elements.settingsPanel.classList.add("is-open");
    this.elements.settingsBackdrop.classList.add("is-open");
  }

  closeSettings() {
    this.elements.settingsPanel.classList.remove("is-open");
    this.elements.settingsBackdrop.classList.remove("is-open");
  }

  toggleBrainDump() {
    const isOpen = this.elements.brainDumpPanel.classList.toggle("is-open");
    this.elements.brainDumpToggle.setAttribute("aria-expanded", String(isOpen));
    this.elements.brainDumpToggle.setAttribute("aria-label", isOpen ? "Close brain dump" : "Open brain dump");
    this.elements.brainDumpToggle.title = isOpen ? "Collapse brain dump" : "Open brain dump";
    this.elements.brainDumpClose.setAttribute("aria-label", isOpen ? "Close brain dump" : "Open brain dump");
    if (isOpen) this.elements.brainDump.focus();
  }

  collapseBrainDump() {
    this.elements.brainDumpPanel.classList.remove("is-open");
    this.elements.brainDumpToggle.setAttribute("aria-expanded", "false");
    this.elements.brainDumpToggle.setAttribute("aria-label", "Open brain dump");
    this.elements.brainDumpToggle.title = "Brain dump";
    this.elements.brainDumpClose.setAttribute("aria-label", "Open brain dump");
  }

  toggleMusicPanel() {
    const isOpen = this.elements.focusMusicPanel.classList.toggle("is-open");
    this.elements.focusMusicToggle.setAttribute("aria-expanded", String(isOpen));
    this.elements.focusMusicToggle.title = isOpen ? "Collapse Music" : "Focus Music";
  }

  collapseMusicPanel() {
    this.elements.focusMusicPanel.classList.remove("is-open");
    this.elements.focusMusicToggle.setAttribute("aria-expanded", "false");
    this.elements.focusMusicToggle.title = "Focus Music";
  }

  askForDailyTarget() {
    const today = this.today();
    if (this.store.state.dailyTarget?.date === today) return;

    const promptFn = typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt.bind(window) : null;
    const answer = promptFn ? promptFn("How many hours do you plan to focus today? Enter a number, such as 4 or 2.5.") : null;
    const hours = answer === null ? null : Number(String(answer).trim());
    this.store.state.dailyTarget = {
      date: today,
      milliseconds: Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 0
    };
    this.store.save();
  }

  render() {
    this.advancePomodoro(Date.now());
    const hasActiveTask = Boolean(this.store.state.active && this.store.findTask(this.store.state.active));
    this.document.body.dataset.focusSession = hasActiveTask ? "active" : "idle";
    const activeTask = hasActiveTask ? this.store.findTask(this.store.state.active) : null;
    this.elements.focusNowWidget.hidden = !activeTask;
    this.updateFullscreenButtonState();
    this.renderClock();
    this.renderStats();
    this.renderPomodoro();
    this.renderPomodoroSettings();
    this.elements.brainDump.value = this.store.state.brainDump;
    if (!this.elements.brainDumpPanel.classList.contains("is-open")) {
      this.elements.brainDumpToggle.setAttribute("aria-expanded", "false");
      this.elements.brainDumpToggle.setAttribute("aria-label", "Open brain dump");
      this.elements.brainDumpToggle.title = "Brain dump";
    }
    this.renderCategoryFilter();
    this.renderTasks();
    this.renderCalendar();
    this.renderActivityCalendar();
    this.renderCategoryEditor();
    this.renderAnalyticsWidgets();
  }

  renderSelectedTaskDate() {
    const [year, month, day] = (this.selectedDate || this.today()).split("-").map(Number);
    this.elements.taskSelectedDate.textContent = new Date(year, month - 1, day).toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  }

  renderTaskPlanner() {
    const year = this.calendarMonth.getFullYear();
    const month = this.calendarMonth.getMonth();
    const monthStart = new Date(year, month, 1);
    const dayCount = new Date(year, month + 1, 0).getDate();
    const dayOffset = monthStart.getDay();
    const rowCount = Math.ceil((dayOffset + dayCount) / 7);
    const monthTasks = this.store.state.tasks.filter(task => {
      const [taskYear, taskMonth] = (task.date || "").split("-").map(Number);
      return taskYear === year && taskMonth === month + 1;
    });

    this.elements.taskPlannerMonth.textContent = monthStart.toLocaleDateString([], {
      month: "long",
      year: "numeric"
    });

    const days = [];
    for (let index = 0; index < rowCount * 7; index += 1) {
      const dayNumber = index - dayOffset + 1;
      if (dayNumber < 1 || dayNumber > dayCount) {
        days.push('<div class="task-planner-day is-outside-month" aria-hidden="true"></div>');
        continue;
      }

      const date = new Date(year, month, dayNumber);
      const dateKey = this.dateKey(date);
      const isToday = dateKey === this.today();
      const isSelected = dateKey === this.selectedDate;
      const dayTasks = monthTasks.filter(task => task.date === dateKey);
      const taskCards = dayTasks.map(task => {
        const category = this.store.state.categories.find(item => item.id === task.category);
        const classes = `task-planner-item${task.done ? " is-done" : ""}`;
        return `<div class="${classes}" draggable="true" data-task-id="${this.escape(task.id)}" style="--category-color:${this.escape(category?.color || "#999")}" title="Drag to reschedule: ${this.escape(task.name)}">${this.escape(task.name)}</div>`;
      }).join("");
      const label = date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

      days.push(`<div class="task-planner-day${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}" data-drop-date="${dateKey}" role="button" tabindex="0" aria-pressed="${isSelected}" aria-label="${this.escape(label)}; ${dayTasks.length} ${dayTasks.length === 1 ? "task" : "tasks"}; drop a task to reschedule">
        <div class="task-planner-day-select"><span>${dayNumber}</span>${isToday ? '<span class="task-planner-today">Today</span>' : ""}</div>
        <div class="task-planner-items">${taskCards}</div>
      </div>`);
    }
    this.elements.taskPlannerGrid.innerHTML = days.join("");
  }

  changeCalendarMonth(offset) {
    if (!Number.isFinite(offset)) return;
    this.calendarMonth = new Date(this.calendarMonth.getFullYear(), this.calendarMonth.getMonth() + offset, 1);
    this.selectedDate = this.dateKey(this.calendarMonth);
    this.calendarAutoScrollPending = true;
    this.render();
  }

  selectPlannerDate(date) {
    if (!this.isDateKey(date)) return;
    this.selectedDate = date;
    this.calendarAutoScrollPending = true;
    this.render();
  }

  selectActivityDate(date) {
    if (!this.isDateKey(date)) return;
    this.selectedDate = date;
    this.selectedActivityYear = Number(date.slice(0, 4));
    const [year, month] = date.split("-").map(Number);
    this.calendarMonth = new Date(year, month - 1, 1);
    this.calendarAutoScrollPending = true;
    this.render();
  }

  beginTaskDrag(event, taskId, taskElement) {
    if (!this.store.findTask(taskId)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", taskId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    taskElement.classList.add("is-dragging");
  }

  scheduleTask(taskId, date) {
    const task = this.store.findTask(taskId);
    if (!task || !this.isDateKey(date) || task.date === date) return;
    task.date = date;
    this.selectedDate = date;
    const [year, month] = date.split("-").map(Number);
    this.calendarMonth = new Date(year, month - 1, 1);
    this.calendarAutoScrollPending = true;
    this.store.save();
    this.render();
  }

  isDateKey(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  renderClock() {
    const currentTime = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const pomodoro = this.store.state.pomodoro;
    const timerRunning = Boolean(pomodoro && !pomodoro.paused && this.store.state.active);

    this.elements.liveTime.textContent = currentTime;
    this.elements.liveTime.hidden = !timerRunning;

    // The date's visibility is owned by CSS (data-pomodoro-state / data-countdown-state), not set here.
    if (!timerRunning) this.elements.clock.textContent = currentTime;
  }

  renderPomodoro(now = Date.now()) {
    const pomodoro = this.store.state.pomodoro;
    
    // The label row is always there (same layout idle and running); only the reset button needs an active task.
    const running = Boolean(pomodoro && this.store.state.active);
    this.elements.pomodoroReset.disabled = !running;
    this.elements.pomodoroReset.dataset.phase = !running ? "idle" : pomodoro.phase === "break" ? "break" : "work";
    
    this.elements.centerStage.dataset.pomodoroState = !pomodoro
      ? "idle"
      : pomodoro.paused
        ? "paused"
        : "running";
    
    if (!running) {
      this.elements.pomodoroPhase.textContent = "Ready to focus";
    }
    if (pomodoro) {
      const phaseDuration = Number.isFinite(pomodoro.phaseDurationMs)
        ? pomodoro.phaseDurationMs
        : this.phaseDurationMs(pomodoro.phase);
      const remaining = pomodoro.paused && Number.isFinite(pomodoro.remainingMs)
        ? pomodoro.remainingMs
        : pomodoro.phaseEndsAt - now;
      const clampedRemaining = Math.max(0, Math.min(phaseDuration, remaining));
      
      // Removed the " paused" text here
      if (running) this.elements.pomodoroPhase.textContent = pomodoro.phase === "break" ? "Break" : "Focus";
      
      if (!pomodoro.paused && this.store.state.active) {
        this.elements.clock.textContent = this.formatPomodoroTime(Math.ceil(clampedRemaining / 1000));
      }
    }

  }

  resetPomodoro() {
    const activeTask = this.store.state.active
      ? this.store.findTask(this.store.state.active)
      : null;
    if (!activeTask) {
      this.store.state.pomodoro = null;
      this.store.save();
      this.render();
      return;
    }

    const now = Date.now();
    const phaseDurationMs = this.focusDurationMs();
    this.store.state.pomodoro = {
      phase: "work",
      phaseStartedAt: now,
      phaseDurationMs,
      phaseEndsAt: now + phaseDurationMs
    };
    if (activeTask.end) this.resumeActiveTask(now);
    this.playPhaseSound("work");
    this.store.save();
    this.render();
  }

  renderPomodoroSettings() {
    this.elements.pomodoroFocusMinutes.value = String(this.store.state.pomodoroSettings.focusMinutes);
    this.elements.pomodoroBreakMinutes.value = String(this.store.state.pomodoroSettings.breakMinutes);
  }

  savePomodoroSettings() {
    const focusMinutes = Number(this.elements.pomodoroFocusMinutes.value);
    const breakMinutes = Number(this.elements.pomodoroBreakMinutes.value);
    if (!Number.isInteger(focusMinutes) || focusMinutes < 1 || focusMinutes > 180) {
      this.elements.pomodoroFocusMinutes.reportValidity();
      return;
    }
    if (!Number.isInteger(breakMinutes) || breakMinutes < 1 || breakMinutes > 60) {
      this.elements.pomodoroBreakMinutes.reportValidity();
      return;
    }

    const now = Date.now();
    this.advancePomodoro(now);
    this.store.state.pomodoroSettings = { focusMinutes, breakMinutes };
    const pomodoro = this.store.state.pomodoro;
    if (pomodoro) {
      const previousDuration = Number.isFinite(pomodoro.phaseDurationMs)
        ? pomodoro.phaseDurationMs
        : this.phaseDurationMs(pomodoro.phase);
      const elapsed = pomodoro.paused && Number.isFinite(pomodoro.remainingMs)
        ? previousDuration - pomodoro.remainingMs
        : now - pomodoro.phaseStartedAt;
      const phaseDuration = this.phaseDurationMs(pomodoro.phase);
      const boundedElapsed = Math.max(0, Math.min(phaseDuration, elapsed));
      const remaining = Math.max(0, phaseDuration - elapsed);
      pomodoro.phaseDurationMs = phaseDuration;
      pomodoro.phaseStartedAt = now - boundedElapsed;
      pomodoro.phaseEndsAt = now + remaining;
      if (pomodoro.paused) pomodoro.remainingMs = remaining;
    }
    this.store.save();
    if (pomodoro && !pomodoro.paused) this.advancePomodoro(Date.now());
    this.renderPomodoroSettings();
    this.renderPomodoro();
  }

  focusDurationMs() {
    const minutes = Number(this.store.state.pomodoroSettings?.focusMinutes);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 180
      ? minutes * 60 * 1000
      : FocusApp.POMODORO_WORK_MS;
  }

  breakDurationMs() {
    const minutes = Number(this.store.state.pomodoroSettings?.breakMinutes);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 60
      ? minutes * 60 * 1000
      : FocusApp.POMODORO_BREAK_MS;
  }

  phaseDurationMs(phase) {
    return phase === "break" ? this.breakDurationMs() : this.focusDurationMs();
  }

  formatPomodoroTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(safeSeconds / 60)).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
  }

  unlockAudio() {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return null;
    try {
      this.audioContext ??= new AudioContextConstructor();
      if (this.audioContext.state === "suspended") this.audioContext.resume().catch(() => {});
      return this.audioContext;
    } catch {
      return null;
    }
  }

  playPhaseSound(phase) {
    const context = this.audioContext || this.unlockAudio();
    if (!context) return;

    const play = () => {
      const frequencies = phase === "break" ? [523.25, 392] : [659.25, 880];
      frequencies.forEach((frequency, index) => {
        const startAt = context.currentTime + index * 0.18;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.07, startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.15);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.16);
      });
    };

    if (context.state === "running") play();
    else context.resume().then(play).catch(() => {});
  }


  updateFullscreenButtonState() {
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    this.elements.fullscreenButton.classList.toggle("is-fullscreen", isFullscreen);
    this.elements.fullscreenButton.setAttribute("aria-pressed", String(isFullscreen));
    this.elements.fullscreenButton.setAttribute("aria-label", isFullscreen ? "Exit full screen" : "Enter full screen");
    this.elements.fullscreenButton.setAttribute("title", isFullscreen ? "Exit full screen" : "Enter Full Screen");
  }

  toggleFullscreen() {
    const element = document.documentElement;
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);

    if (isFullscreen) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }

    if (element.requestFullscreen) element.requestFullscreen();
    else if (element.webkitRequestFullscreen) element.webkitRequestFullscreen();
  }

  // ---- YouTube video background ----------------------------------------------------------
  // Accepts watch / youtu.be / embed / shorts / live links or a bare 11-character id.
  parseYouTubeId(text) {
    const value = String(text || "").trim();
    if (/^[\w-]{11}$/.test(value)) return value;
    let url;
    try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`); } catch { return null; }
    const host = url.hostname.replace(/^(www|m|music)\./, "");
    let id = null;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const [, kind, second] = url.pathname.split("/");
      id = kind === "watch" ? url.searchParams.get("v") : ["embed", "shorts", "live", "v"].includes(kind) ? second : null;
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  applyBackgroundVideoInput() {
    const id = this.parseYouTubeId(this.elements.backgroundVideoUrl.value);
    if (!id) {
      this.showBackgroundVideoStatus("That doesn't look like a YouTube link.", true);
      return;
    }
    this.setBackgroundVideo(id);
  }

  showBackgroundVideoStatus(message, isError = false) {
    const status = this.elements.backgroundVideoStatus;
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  // Looping, muted, controls-free iframe behind everything (CSS: .bg-video). The still image stays
  // underneath as the fallback while the video loads or if YouTube refuses to play it.
  setBackgroundVideo(id, persist = true) {
    this.document.getElementById("bgVideo")?.remove();
    this.elements.backgroundVideoClear.hidden = !id;
    if (!id) {
      if (persist) { localStorage.removeItem("focus-background-video"); window.dispatchEvent(new Event("focus-changed")); }
      this.showBackgroundVideoStatus("");
      return;
    }
    const params = new URLSearchParams({
      autoplay: "1", mute: "1", controls: "0", loop: "1", playlist: id, playsinline: "1",
      modestbranding: "1", rel: "0", disablekb: "1", iv_load_policy: "3", fs: "0"
    });
    const wrap = this.document.createElement("div");
    wrap.id = "bgVideo";
    wrap.className = "bg-video";
    wrap.setAttribute("aria-hidden", "true");
    const frame = this.document.createElement("iframe");
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
    frame.allow = "autoplay; encrypted-media";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.tabIndex = -1;
    frame.title = "Background video";
    frame.onload = () => wrap.classList.add("is-ready");
    wrap.appendChild(frame);
    this.document.body.prepend(wrap);
    this.elements.backgroundVideoUrl.value = `https://youtu.be/${id}`;
    this.showBackgroundVideoStatus(location.protocol === "file:"
      ? "Playing. If the video stays black, YouTube blocks players on pages opened as files (error 153): serve the folder over http, e.g. VS Code Live Server."
      : "Playing.");
    if (persist) localStorage.setItem("focus-background-video", id); if (persist) window.dispatchEvent(new Event("focus-changed"));
  }

  setBackgroundImage(image, persist = true) {
    const background = this.backgrounds.find(bg => bg.id === image);
    if (!background) return;
    this.selectedBackgroundImage = image;
    this.document.body.style.backgroundImage = `url("${background.src}")`;
    this.elements.backgroundChoices.querySelectorAll("[data-background]").forEach(choice => {
      const selected = choice.dataset.background === image;
      choice.classList.toggle("is-active", selected);
      choice.setAttribute("aria-pressed", String(selected));
    });
    if (persist) localStorage.setItem("focus-background-image", image); if (persist) window.dispatchEvent(new Event("focus-changed"));
  }


  // ---- Clock fonts ------------------------------------------------------------
  // The name is the file name: "My Cool Font.ttf" -> My Cool Font. Style endings are only used to
  // pick the weight and to group files of one family: "Jost-VariableFont_wght.ttf" -> Jost (variable),
  // "Unkempt-Bold.ttf" -> Unkempt 700.
  parseFontFile(name) {
    const base = name.replace(/\.[^.]+$/, "");
    const variable = /variable|\[.*wght.*\]/i.test(base);
    let family = base.replace(/\[[^\]]*\]/g, "").replace(/[-_ ]*variable(?:[-_ ]?font)?(?:[-_ ]\w+)*$/i, "");
    const styleWords = "thin|extralight|ultralight|light|regular|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique";
    const ending = new RegExp(`[-_ ]+(${styleWords})$`, "i");
    const style = [];
    for (let match = family.match(ending); match && family.length > match[0].length; match = family.match(ending)) {
      style.unshift(match[1].toLowerCase());
      family = family.slice(0, -match[0].length);
    }
    family = family.replace(/[-_]+/g, " ").replace(/["'\\]/g, "").replace(/\s+/g, " ").trim() || base;
    const weights = { thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, medium: 500, semibold: 600,
      demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
    const weight = variable ? 400 : (style.map(word => weights[word]).find(Boolean) ?? 400);
    return { family, weight, variable, italic: style.some(word => word === "italic" || word === "oblique") };
  }

  async loadClockFonts() {
    const found = new Set();
    const add = name => {
      const file = String(name).split(/[\\/]/).pop();
      if (file && !file.startsWith(".") && FocusApp.FONT_EXT.test(file)) found.add(file);
    };
    try {                                          // 1. manifest from update-lists.py
      const response = await fetch("fonts/fonts.json", { cache: "no-cache" });
      if (response.ok) (await response.json()).forEach(add);
    } catch { /* no manifest */ }
    try {                                          // 2. folder listing (dev servers)
      const response = await fetch("fonts/");
      if (response.ok) {
        const html = await response.text();
        for (const match of html.matchAll(/href="([^"?#]+)"/gi)) {
          try { add(decodeURIComponent(match[1])); } catch { /* bad escape */ }
        }
      }
    } catch { /* file:// or no listing */ }
    const names = found.size ? [...found] : FocusApp.BUNDLED_FONT_FILES;   // 3. fallback
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const files = new Map(names.map(name => [name, new URL(`fonts/${encodeURIComponent(name)}`, location.href).href]));

    this.clockFonts = new Map();
    files.forEach((src, name) => {
      const info = this.parseFontFile(name);
      if (info.italic) return;
      const entry = this.clockFonts.get(info.family) || { family: info.family, faces: [] };
      entry.faces.push({ ...info, src });
      this.clockFonts.set(info.family, entry);
    });
    this.clockFonts.forEach(entry => {
      // The clock uses the heaviest weight available; variable fonts use 700.
      const variable = entry.faces.find(face => face.variable);
      entry.weight = variable ? 700 : Math.max(...entry.faces.map(face => face.weight));
    });
    this.installFontStyles();
    if (!this.clockFonts.has(this.clockFont)) this.clockFont = this.clockFonts.has(FocusApp.DEFAULT_CLOCK_FONT)
      ? FocusApp.DEFAULT_CLOCK_FONT : [...this.clockFonts.keys()][0];
    this.renderClockFontChoices();
    if (this.clockFont) this.setClockFont(this.clockFont, false);
  }

  // One <style> with every @font-face, kept in sync in the page and in the PiP window.
  installFontStyles() {
    const css = [...this.clockFonts.values()].flatMap(entry => entry.faces.map(face =>
      `@font-face{font-family:"${entry.family}";src:url("${face.src}");font-weight:${face.variable ? "100 900" : face.weight};font-display:swap}`)).join("\n");
    const docs = [document];
    const pip = window.documentPictureInPicture?.window;
    if (pip) docs.push(pip.document);
    docs.forEach(doc => {
      let style = doc.getElementById("clockFontFaces");
      if (!style) { style = doc.createElement("style"); style.id = "clockFontFaces"; doc.head.appendChild(style); }
      style.textContent = css;
    });
  }

  // The font is set on #centerStage itself, so it follows the panel into the PiP window.
  setClockFont(family, persist = true) {
    this.clockFont = family;
    const panel = this.elements.centerStage;
    panel.style.setProperty("--clock-font", `"${family}"`);
    panel.style.setProperty("--clock-weight", String(this.clockFonts.get(family)?.weight ?? 700));
    this.elements.clockFontChoices.querySelectorAll("[data-font]").forEach(choice => {
      const selected = choice.dataset.font === family;
      choice.classList.toggle("is-active", selected);
      choice.setAttribute("aria-pressed", String(selected));
    });
    if (persist) localStorage.setItem("focus-clock-font", family); if (persist) window.dispatchEvent(new Event("focus-changed"));
  }

  renderClockFontChoices() {
    this.elements.clockFontChoices.innerHTML = [...this.clockFonts.values()].map(font =>
      `<button class="font-choice" type="button" data-font="${this.escape(font.family)}" aria-pressed="false"><span class="font-choice-sample" style="font-family:'${this.escape(font.family)}',Impact,sans-serif;font-weight:${font.weight}">12:34</span><span class="font-choice-name">${this.escape(font.family)}</span></button>`
    ).join("");
    this.elements.clockFontChoices.querySelectorAll("[data-font]").forEach(choice =>
      choice.classList.toggle("is-active", choice.dataset.font === this.clockFont));
  }

  renderBackgroundChoices() {
    const esc = value => this.escape(value);
    this.elements.backgroundChoices.innerHTML = this.backgrounds.map(bg =>
      `<div class="background-item"><button class="background-choice" type="button" data-background="${esc(bg.id)}" aria-pressed="false" title="${esc(bg.name)}"><img src="${esc(bg.src)}" alt="" loading="lazy"><span>${esc(bg.name)}</span></button>` +
      (bg.custom ? `<button class="ui-button background-delete" type="button" data-background-delete="${esc(bg.id)}" aria-label="Delete ${esc(bg.name)}" title="Delete">×</button>` : "") +
      `</div>`
    ).join("") +
    `<div class="background-item"><button class="background-choice background-add" type="button" data-background-add title="Upload your own image"><span class="background-add-art"><img src="icons/image-plus.svg" alt="" onerror="this.replaceWith(document.createTextNode('+'))"></span><span>Add image</span></button></div>`;
  }

  // ---- Background library (./images + uploads) ----------------------------------------------
  folderBackground(file) {
    return { id: `images/${file}`, src: `images/${encodeURIComponent(file)}`, name: file.replace(/\.[^.]+$/, "") };
  }

  async loadBackgrounds() {
    const found = new Set();
    const add = name => {
      const file = String(name).split(/[\\/]/).pop();
      if (file && !file.startsWith(".") && FocusApp.BACKGROUND_EXT.test(file)) found.add(file);
    };
    try {                                          // 1. manifest from update-backgrounds.py
      const response = await fetch("images/backgrounds.json", { cache: "no-cache" });
      if (response.ok) (await response.json()).forEach(add);
    } catch { /* no manifest */ }
    try {                                          // 2. folder listing (dev servers)
      const response = await fetch("images/");
      if (response.ok) {
        const html = await response.text();
        for (const match of html.matchAll(/href="([^"?#]+)"/gi)) {
          try { add(decodeURIComponent(match[1])); } catch { /* bad escape */ }
        }
      }
    } catch { /* file:// or no listing */ }
    const files = found.size ? [...found] : FocusApp.BUNDLED_BACKGROUND_FILES;   // 3. fallback
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    this.folderBackgrounds = files.map(file => this.folderBackground(file));
    await this.refreshBackgrounds();
  }

  async refreshBackgrounds() {
    this.backgrounds = [...this.folderBackgrounds, ...await this.loadCustomBackgrounds()];
    this.renderBackgroundChoices();
    const saved = localStorage.getItem("focus-background-image");
    const wanted = [this.selectedBackgroundImage, saved].find(id => this.backgrounds.some(bg => bg.id === id)) ?? this.backgrounds[0]?.id;
    if (wanted) this.setBackgroundImage(wanted, false);
  }

  showBackgroundUploadStatus(message, isError = false) {
    const status = this.elements.backgroundUploadStatus;
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  // Uploaded images live in IndexedDB on this device (localStorage is too small for pictures).
  backgroundDb() {
    this.backgroundDbPromise ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(FocusApp.BACKGROUND_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("images", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.backgroundDbPromise;
  }

  async backgroundStore(mode, run) {
    const db = await this.backgroundDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("images", mode);
      const request = run(transaction.objectStore("images"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async loadCustomBackgrounds() {
    try {
      const rows = await this.backgroundStore("readonly", store => store.getAll());
      return rows.sort((a, b) => a.added - b.added).map(row => {
        if (!this.customBackgroundUrls.has(row.id)) this.customBackgroundUrls.set(row.id, URL.createObjectURL(row.blob));
        return { id: `custom:${row.id}`, src: this.customBackgroundUrls.get(row.id), name: row.name, custom: true };
      });
    } catch { return []; }                         // storage blocked (e.g. private mode)
  }

  // Big photos are shrunk to at most 2560px so they stay light and load fast.
  async downscaleImage(file, max = 2560) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 4 * 1024 * 1024) { bitmap.close?.(); return file; }
    const canvas = this.document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return new Promise((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn't process that image.")), "image/jpeg", 0.88));
  }

  async addCustomBackground() {
    const input = this.elements.backgroundUploadInput;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return this.showBackgroundUploadStatus("That isn't an image file.", true);
    const name = file.name.replace(/\.[^.]+$/, "");
    try {
      const blob = await this.downscaleImage(file);
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      await this.backgroundStore("readwrite", store => store.put({ id, name, blob, added: Date.now() }));
      await this.refreshBackgrounds();
      this.setBackgroundVideo(null);
      this.setBackgroundImage(`custom:${id}`);
      this.showBackgroundUploadStatus(`Added "${name}". It is saved on this device only.`);
    } catch (error) {
      this.showBackgroundUploadStatus(error?.message || "Couldn't save that image.", true);
    }
  }

  async deleteCustomBackground(id) {
    const background = this.backgrounds.find(bg => bg.id === id);
    if (!background || !confirm(`Delete "${background.name}"?`)) return;
    const rawId = id.slice("custom:".length);
    try {
      await this.backgroundStore("readwrite", store => store.delete(rawId));
    } catch { return this.showBackgroundUploadStatus("Couldn't delete that image.", true); }
    URL.revokeObjectURL(this.customBackgroundUrls.get(rawId));
    this.customBackgroundUrls.delete(rawId);
    const wasSelected = this.selectedBackgroundImage === id;
    if (wasSelected) this.selectedBackgroundImage = null;
    await this.refreshBackgrounds();
    if (wasSelected) this.setBackgroundImage(this.backgrounds[0].id);
    this.showBackgroundUploadStatus("");
  }

  renderCategoryFilter() {
    const { categories, tasks } = this.store.state;
    const activeDate = this.selectedDate || this.today();
    const allCount = tasks.filter(task => task.date === activeDate).length;
    const options = [`<option value="all">All categories (${allCount})</option>`];

    categories.forEach(category => {
      const count = tasks.filter(task =>
        task.date === activeDate && task.category === category.id
      ).length;
      options.push(`<option value="${this.escape(category.id)}">${this.escape(category.name)} (${count})</option>`);
    });

    this.elements.categoryFilter.innerHTML = options.join("");
    this.elements.categoryFilter.value = this.selectedCategory;
    this.elements.categoryFilter.onchange = event => {
      this.selectedCategory = event.target.value;
      this.renderTasks();
    };
  }

  renderCategoryEditor() {
    const counts = new Map();
    this.store.state.tasks.forEach(task => counts.set(task.category, (counts.get(task.category) || 0) + 1));
    this.elements.categoryEditor.innerHTML = this.store.state.categories.length
      ? this.store.state.categories.map(category => `<div class="category-row" data-category-id="${this.escape(category.id)}">
          <input class="category-color" type="color" value="${this.colorPickerValue(category.color)}" aria-label="Change ${this.escape(category.name)} color">
          <input class="ui-field category-name" type="text" value="${this.escape(category.name)}" maxlength="40" aria-label="Category name">
          <span class="count">${counts.get(category.id) || 0} ${(counts.get(category.id) || 0) === 1 ? "task" : "tasks"}</span>
          <button class="ui-control remove-category" type="button" data-action="remove-category" title="Remove ${this.escape(category.name)}" aria-label="Remove ${this.escape(category.name)}">×</button>
        </div>`).join("")
      : '<div class="category-editor-empty">No categories yet.</div>';

    this.elements.categoryEditor.querySelectorAll(".category-row").forEach(row => {
      const categoryId = row.dataset.categoryId;
      row.querySelector(".category-color").oninput = event => this.changeCategoryColor(categoryId, event.target.value);
      const nameField = row.querySelector(".category-name");
      nameField.onchange = () => this.renameCategory(categoryId, nameField.value);
      nameField.onkeydown = event => { if (event.key === "Enter") nameField.blur(); };
      row.querySelector('[data-action="remove-category"]').onclick = () => this.removeCategory(categoryId);
    });
  }

  renameCategory(id, name) {
    const category = this.store.state.categories.find(item => item.id === id);
    const clean = name.trim();
    if (!category) return;
    if (!clean) { this.renderCategoryEditor(); return; }
    category.name = clean;
    this.store.save();
    this.render();
  }

  changeCategoryColor(id, color) {
    const category = this.store.state.categories.find(item => item.id === id);
    if (!category) return;
    category.color = color;
    this.store.save();
    this.renderTasks();
  }

  removeCategory(id) {
    const category = this.store.state.categories.find(item => item.id === id);
    if (!category || !window.confirm(`Remove category "${category.name}"?`)) return;
    this.store.state.categories = this.store.state.categories.filter(item => item.id !== id);
    const fallback = this.store.state.categories[0]?.id || "";
    this.store.state.tasks.forEach(task => {
      if (task.category === id) task.category = fallback;
    });
    if (this.selectedCategory === id) this.selectedCategory = "all";
    this.store.save();
    this.render();
  }

  renderTasks(force = false) {
    this.renderFocusSummary();
    this.renderTaskPlanner();
    this.renderSelectedTaskDate();
    if (this.editingTaskId && !force) {
      const editingTask = this.store.findTask(this.editingTaskId);
      if (editingTask) return;
      this.editingTaskId = null;
    }
    const activeDate = this.selectedDate || this.today();
    const tasks = this.store.state.tasks
      .filter(task => task.date === activeDate)
      .filter(task => this.selectedCategory === "all" || task.category === this.selectedCategory)
      .filter(task => !this.hideCompleted || !task.done) // Add this filter line
      .sort((first, second) => (first.created || 0) - (second.created || 0));
    const todaysTasks = this.store.state.tasks
      .filter(task => task.date === this.today())
      .sort((first, second) => (first.created || 0) - (second.created || 0));

    // 1. Render tasks for the main Tasks page
    this.renderTaskList(this.elements.tasks, tasks);
    
    // 2. Render tasks into the new PiP dropdown
    this.elements.focusTasksList.innerHTML = todaysTasks.length
      ? todaysTasks.map(task => this.taskMarkup(task)).join("")
      : '<div class="empty" style="padding: 20px; font-size: 1.2em;">No tasks today.</div>';
      
    // 3. Update the task counter badge in the dropdown header
    this.elements.focusTasksCount.textContent = todaysTasks.length;

    // 4. Toggle the visibility between the Active Widget and the Idle Dropdown
    const activeTask = this.store.state.active
      ? this.store.findTask(this.store.state.active)
      : null;
      
    this.elements.focusNowWidget.hidden = !activeTask;
    this.elements.focusIdleWidget.hidden = Boolean(activeTask);

    // 5. If a task is currently active, force-close the dropdown so it doesn't overlap the timer
    if (activeTask) this.closeFocusTasks();

    // 6. Render the active task widget
    this.elements.focusNowTask.innerHTML = activeTask ? this.taskMarkup(activeTask, true) : "";
    
    // 7. Bind events to the tasks in all three places
    this.bindTaskEvents(this.elements.tasks);            // Main Tasks page
    this.bindTaskEvents(this.elements.focusTasksList);   // The new dropdown
    this.bindTaskEvents(this.elements.focusNowTask);     // The active task widget
    
    this.restoreExpandedTask();
  }

  restoreExpandedTask() {
    if (!this.expandedTaskId) return;
    
    // Clear the modal so we can insert the newly rendered details
    const modal = this.document.getElementById("taskModal");
    if (modal) {
        modal.innerHTML = "";
        modal.hidden = true;
    }

    const taskElements = this.document.querySelectorAll(`.task[data-task-id="${this.expandedTaskId}"]`);
    if (!taskElements.length) {
      this.expandedTaskId = null;
      this.activeTaskRow = null;
      return;
    }
    
    taskElements.forEach(taskEl => {
      const row = taskEl.closest(".task-row");
      const details = row?.querySelector(".task-details");
      if (row && details) {
        row.classList.add("is-expanded");
        details.hidden = false;
        
        if (modal) {
          modal.appendChild(details);
          modal.hidden = false;
          this.activeTaskRow = row; // Save the new row
        }
      }
    });
  }

  renderTaskList(container, tasks) {
    container.innerHTML = tasks.length
      ? tasks.map(task => this.taskMarkup(task)).join("")
      : '<div class="empty">No tasks yet.<br><span>Add one to begin.</span></div>';
  }

  renderLiveTimers() {
    // Changed this.elements.focusTasks to this.elements.focusTasksList
    [this.elements.tasks, this.elements.focusTasksList, this.elements.focusNowTask].forEach(container => {
      if (!container) return;
      container.querySelectorAll(".task[data-task-id]").forEach(taskElement => {
        const task = this.store.findTask(taskElement.dataset.taskId);
        if (!task) return;
        const eta = taskElement.querySelector(".eta");
        if (eta) eta.textContent = this.etaText(task);
        const timer = taskElement.querySelector(".timer");
        if (!timer) return;

        const duration = this.duration(this.taskDuration(task));
        timer.textContent = task.end && this.store.state.active !== task.id
          ? `Focused for ${duration}`
          : duration;
      });
    });
  }

  renderCalendar(now = Date.now()) {
    this.lastCalendarMinute = Math.floor(now / 60000);
    const [year, month, day] = (this.selectedDate || this.today()).split("-").map(Number);
    const dayStart = new Date(year, month - 1, day).getTime();
    const dayEnd = new Date(year, month - 1, day + 1).getTime();
    const dayLength = dayEnd - dayStart;
    const isToday = this.selectedDate === this.today();
    this.elements.taskCalendar.style.height = `${dayLength / (60 * 60 * 1000) * 60}px`;
    this.elements.calendarDate.textContent = isToday
      ? "Today"
      : new Date(year, month - 1, day).toLocaleDateString([], { month: "short", day: "numeric" });

    const hours = Array.from({ length: 25 }, (_, hour) => {
      const hourTime = new Date(year, month - 1, day, hour).getTime();
      const position = ((hourTime - dayStart) / dayLength) * 100;
      const label = hour === 24 ? "24" : String(hour).padStart(2, "0");
      return `<div class="timeline-hour" style="--hour-top:${position}%"><span>${label}:00</span></div>`;
    }).join("");
    // 1. Collect this day's sessions per task, then fuse sessions of the same task that are
    //    less than MERGE_GAP apart (or overlap) into one continuous block.
    const MERGE_GAP = 10 * 60 * 1000;
    const HOUR_PX = 60;                       // must match the grid height set above
    const MIN_BLOCK_MS = (17 / HOUR_PX) * 60 * 60 * 1000;   // a block is never drawn shorter than 17px
    const blocks = [];
    this.store.state.tasks.forEach(task => {
      const category = this.store.state.categories.find(item => item.id === task.category);
      const spans = this.taskSessions(task, now)
        .map(session => ({
          start: Math.max(new Date(session.start).getTime(), dayStart),
          end: Math.min(new Date(session.end).getTime(), dayEnd)
        }))
        .filter(span => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
        .sort((first, second) => first.start - second.start);
      let current = null;
      spans.forEach(span => {
        if (current && span.start - current.end < MERGE_GAP) {
          current.focusMs += Math.max(0, span.end - Math.max(span.start, current.end));
          current.end = Math.max(current.end, span.end);
          current.sessions += 1;
        } else {
          current = { task, category, start: span.start, end: span.end, focusMs: span.end - span.start, sessions: 1 };
          blocks.push(current);
        }
      });
    });

    // 2. Blocks of different tasks that overlap in time sit side by side instead of on top of each other.
    blocks.sort((first, second) => first.start - second.start || second.end - first.end);
    let cluster = [], clusterEnd = 0;
    const closeCluster = () => {
      const lanes = cluster.reduce((max, block) => Math.max(max, block.lane + 1), 1);
      cluster.forEach(block => { block.lanes = lanes; });
      cluster = [];
    };
    const laneEnds = [];
    blocks.forEach(block => {
      block.visualEnd = Math.max(block.end, block.start + MIN_BLOCK_MS);
      if (cluster.length && block.start >= clusterEnd) { closeCluster(); laneEnds.length = 0; clusterEnd = 0; }
      let lane = laneEnds.findIndex(end => end <= block.start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = block.visualEnd;
      block.lane = lane;
      cluster.push(block);
      clusterEnd = Math.max(clusterEnd, block.visualEnd);
    });
    if (cluster.length) closeCluster();

    // 3. Markup.
    let totalFocusMs = 0;
    const events = blocks.map(block => {
      totalFocusMs += block.focusMs;
      const top = ((block.start - dayStart) / dayLength) * 100;
      const height = ((block.end - block.start) / dayLength) * 100;
      const heightPx = ((block.end - block.start) / 3600000) * HOUR_PX;
      const color = this.escape(block.category?.color || "#999");
      const range = `${this.formatTime(block.start)}–${this.formatTime(block.end)}`;
      const live = isToday && this.store.state.active === block.task.id && block.end >= now - 1000;
      const detail = `${block.task.name}${block.category ? ` · ${block.category.name}` : ""}\n${range} · ${this.duration(block.focusMs)} focused${block.sessions > 1 ? ` (${block.sessions} sessions merged)` : ""}`;
      const time = heightPx >= 38 ? `<span class="timeline-event-time">${range}</span>` : "";
      return `<div class="timeline-event${heightPx < 22 ? " is-short" : ""}${live ? " is-live" : ""}" style="--event-color:${color};--event-top:${top}%;--event-height:${height}%;--lane:${block.lane};--lanes:${block.lanes}" title="${this.escape(detail)}"><span class="timeline-event-name">${this.escape(block.task.name)}</span>${time}</div>`;
    });

    this.elements.calendarDate.textContent = (isToday
      ? "Today"
      : new Date(year, month - 1, day).toLocaleDateString([], { month: "short", day: "numeric" }))
      + (totalFocusMs ? ` · ${this.duration(totalFocusMs)}` : "");
    this.elements.calendarDate.title = isToday ? "Click to jump to now" : "";
    this.elements.calendarDate.onclick = () => {
      if (!isToday) return;
      const target = ((Date.now() - dayStart) / dayLength) * this.elements.taskCalendar.scrollHeight - this.elements.calendarScroll.clientHeight / 2;
      this.elements.calendarScroll.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    };

    const nowPosition = ((now - dayStart) / dayLength) * 100;
    const nowMarker = isToday && now >= dayStart && now < dayEnd
      ? `<div class="timeline-now" style="--event-top:${nowPosition}%"><span>Now</span></div>`
      : "";
    this.elements.taskCalendar.innerHTML = `${hours}${events.join("")}${nowMarker}${events.length ? "" : '<div class="timeline-empty">No sessions recorded</div>'}`;

    if (this.calendarAutoScrollPending) {
      this.calendarAutoScrollPending = false;
      const scrollPosition = isToday
        ? Math.max(0, ((now - dayStart) / dayLength) * this.elements.taskCalendar.scrollHeight - this.elements.calendarScroll.clientHeight / 2)
        : 0;
      this.elements.calendarScroll.scrollTop = scrollPosition;
    }
  }

  ensureTaskSessions(task) {
    if (Array.isArray(task.sessions)) return;
    task.sessions = task.start && task.end ? [{ start: task.start, end: task.end }] : [];
  }

  recordTaskSession(task, end) {
    this.ensureTaskSessions(task);
    const startTime = new Date(task.start).getTime();
    const endTime = new Date(end).getTime();
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return;
    if (task.sessions.some(session => session.start === task.start && session.end === end)) return;
    task.sessions.push({ start: task.start, end });
  }

  renderFocusSummary() {
    const categories = this.store.state.categories;
    const activeDate = this.selectedDate || this.today();
    const totals = categories.map(category => ({
      ...category,
      milliseconds: 0
    }));
    const now = Date.now();
    let totalMilliseconds = 0;
    this.store.state.tasks.forEach(task => {
      const milliseconds = this.focusDurationOnDate(task, activeDate, now);
      totalMilliseconds += milliseconds;
      const category = totals.find(item => item.id === task.category);
      if (category) category.milliseconds += milliseconds;
      else {
        let uncategorized = totals.find(item => item.id === "");
        if (!uncategorized) {
          uncategorized = { id: "", name: "Uncategorized", color: "#999", milliseconds: 0 };
          totals.push(uncategorized);
        }
        uncategorized.milliseconds += milliseconds;
      }
    });

    this.elements.focusSelectedDate.textContent = this.formatTaskDate(activeDate);
    this.elements.focusTotal.textContent = this.duration(totalMilliseconds);
    const target = this.store.state.dailyTarget;
    const targetMilliseconds = target?.date === activeDate ? target.milliseconds : 0;
    const progress = targetMilliseconds ? Math.min(100, (totalMilliseconds / targetMilliseconds) * 100) : 0;
    // Daily target bar, fragmented by category. Segment width = share of the target
    // (or of the total once the target is exceeded, so the bar never overflows).
    const withTime = totals.filter(category => category.milliseconds > 0);
    const legend = totals.length
      ? `<div class="focus-legend" aria-label="Category colours">${totals.map(category =>
        `<span class="focus-legend-item"><span class="dot" style="background:${this.escape(category.color)}"></span>${this.escape(category.name)}</span>`).join("")}</div>`
      : "";
    if (targetMilliseconds) {
      const scale = Math.max(targetMilliseconds, totalMilliseconds);
      const segments = withTime.map(category =>
        `<span class="focus-goal-segment" style="width:${(category.milliseconds / scale) * 100}%;background:${this.escape(category.color)}" data-name="${this.escape(category.name)}" data-time="${this.escape(this.duration(category.milliseconds))}" data-color="${this.escape(category.color)}"></span>`).join("");
      this.elements.focusProgress.innerHTML = `<div class="focus-goal-label"><span>Daily target</span><span>${this.duration(totalMilliseconds)} / ${this.duration(targetMilliseconds)}</span></div>
        <div class="focus-goal-wrap"><div class="focus-goal-track" role="progressbar" aria-label="Daily focus target progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}">${segments}</div><div class="focus-goal-tip" hidden></div></div>${legend}`;
      const wrap = this.elements.focusProgress.querySelector(".focus-goal-wrap");
      const tip = wrap.querySelector(".focus-goal-tip");
      wrap.onmousemove = event => {
        const segment = event.target.closest(".focus-goal-segment");
        if (!segment) { tip.hidden = true; return; }
        tip.innerHTML = `<span class="dot" style="background:${segment.dataset.color}"></span><b>${segment.dataset.name}</b> ${segment.dataset.time}`;
        tip.hidden = false;
        const box = wrap.getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max(event.clientX - box.left, tip.offsetWidth / 2), box.width - tip.offsetWidth / 2)}px`;
      };
      wrap.onmouseleave = () => { tip.hidden = true; };
    } else {
      this.elements.focusProgress.innerHTML = `<div class="focus-goal-empty">No focus target set for this day.</div>${legend}`;
    }
  }


  // ---- Analytics widgets ---------------------------------------------------------
  // Built only from parts the page already has: .panel, .panel-title, .focus-total + .focus-label
  // (the big number) and .focus-goal-label + .focus-goal-track (a labelled row, optionally with a bar).
  analyticsData(now = Date.now()) {
    const { tasks, categories } = this.store.state;
    const perDay = new Map(), perCategory = new Map(), perTask = new Map();
    const perHour = Array(24).fill(0);
    tasks.forEach(task => this.taskSessions(task, now).forEach(session => {
      const a = new Date(session.start).getTime(), b = new Date(session.end).getTime();
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return;
      const add = (map, key) => map.set(key, (map.get(key) || 0) + (b - a));
      add(perTask, task.id);
      add(perCategory, task.category || "");
      for (let cursor = a; cursor < b;) {
        const date = new Date(cursor);
        const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1).getTime();
        const slice = Math.min(b, next) - cursor;
        perHour[date.getHours()] += slice;
        const key = this.dateKey(date);
        perDay.set(key, (perDay.get(key) || 0) + slice);
        cursor += slice;
      }
    }));
    return { tasks, categories, perDay, perCategory, perTask, perHour };
  }

  renderAnalyticsWidgets() {
    const host = this.elements.analyticsWidgets;
    if (!host || this.document.body.dataset.page !== "analytics") return;
    const d = this.analyticsData();
    const dur = ms => this.duration(ms);
    const sum = list => list.reduce((total, ms) => total + ms, 0);
    const pct = (part, whole) => whole > 0 ? Math.round((part / whole) * 100) : 0;
    const dayKey = offset => { const x = new Date(); x.setDate(x.getDate() - offset); return this.dateKey(x); };
    const dayTotal = key => d.perDay.get(key) || 0;
    const totalMs = sum([...d.perDay.values()]);
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const hourLabel = h => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
    const change = (now, before) => before > 0 ? `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%` : "–";

    // this week (since Monday) vs last week
    const mondayOffset = (new Date().getDay() + 6) % 7;
    const thisWeek = sum(Array.from({ length: mondayOffset + 1 }, (_, i) => dayTotal(dayKey(i))));
    const lastWeek = sum(Array.from({ length: 7 }, (_, i) => dayTotal(dayKey(mondayOffset + 1 + i))));
    const activeDays = [...d.perDay].filter(([, v]) => v > 0).length;

    // time of day, day of week
    const buckets = [["Morning · 5–12", 5, 12], ["Afternoon · 12–17", 12, 17], ["Evening · 17–22", 17, 22], ["Night · 22–5", 22, 29]]
      .map(([label, from, to]) => ({ label, value: sum(Array.from({ length: to - from }, (_, i) => d.perHour[(from + i) % 24])) }));
    const peakHour = d.perHour.indexOf(Math.max(...d.perHour));
    const weekdayTotals = Array(7).fill(0);
    d.perDay.forEach((ms, key) => { weekdayTotals[(new Date(`${key}T00:00:00`).getDay() + 6) % 7] += ms; });
    const bestWeekday = weekdayTotals.indexOf(Math.max(...weekdayTotals));

    // categories
    const catName = id => d.categories.find(c => c.id === id)?.name || "Uncategorized";
    const catColor = id => d.categories.find(c => c.id === id)?.color || "#999";
    const catRows = [...d.perCategory].sort((x, y) => y[1] - x[1]).slice(0, 5);

    // estimates: finished tasks that had an estimate and real focus time
    const [lo, hi] = FocusApp.RAINDROPS.onTargetBand;
    const rated = d.tasks.filter(t => t.done && t.estimateMs > 0 && (d.perTask.get(t.id) || 0) >= FocusApp.RAINDROPS.minFocusMs);
    const ratio = t => (d.perTask.get(t.id) || 0) / t.estimateMs;
    const faster = rated.filter(t => ratio(t) < lo).length;
    const slower = rated.filter(t => ratio(t) > hi).length;
    const onTarget = rated.length - faster - slower;

    const bars = (items, fmt = dur) => {
      const max = Math.max(0, ...items.map(i => i.value));
      return items.map(i => ({ label: i.label, value: fmt(i.value), bar: max > 0 ? (i.value / max) * 100 : 0, color: i.color || "var(--rain)" }));
    };
    const widgets = [
      { title: "This week", big: dur(thisWeek), label: "Focus time since Monday", rows: [
        ...bars([{ label: "This week", value: thisWeek }, { label: "Last week", value: lastWeek }]),
        { label: "Change", value: change(thisWeek, lastWeek) }, { label: "Days with focus, all time", value: activeDays }] },
      { title: "Time of day", big: totalMs ? hourLabel(peakHour) : "–", label: "Most productive hour", rows: bars(buckets) },
      { title: "Day of week", big: totalMs ? dayNames[bestWeekday] : "–", label: "Most productive weekday", rows: bars(dayNames.map((label, i) => ({ label, value: weekdayTotals[i] }))) },
      { title: "Categories", big: catRows.length ? catName(catRows[0][0]) : "–", label: "Most focused category, all time",
        rows: bars(catRows.map(([id, ms]) => ({ label: catName(id), value: ms, color: catColor(id) })), ms => `${dur(ms)} · ${pct(ms, totalMs)}%`) },
      { title: "Estimates", big: rated.length ? `${pct(onTarget, rated.length)}%` : "–", label: "Finished tasks on target", rows:
        bars([{ label: "Faster than estimated", value: faster }, { label: "On target", value: onTarget }, { label: "Slower than estimated", value: slower }], String) }
    ];

    const row = r => `<div class="focus-goal-label"><span>${this.escape(r.label)}</span><span>${this.escape(r.value)}</span></div>${
      r.bar === undefined ? "" : `<div class="focus-goal-track"><span class="focus-goal-segment" style="width:${r.bar}%;background:${this.escape(r.color)}"></span></div>`}`;
    const html = widgets.map(w => `<section class="panel"><h2 class="panel-title">${this.escape(w.title)}</h2><div class="focus-total">${this.escape(w.big)}</div><div class="focus-label">${this.escape(w.label)}</div>${w.rows.map(row).join("")}</section>`).join("");
    if (html !== this.lastWidgetsHtml) { host.innerHTML = html; this.lastWidgetsHtml = html; }
  }

  // ---- Colour helpers (OKLCH) ------------------------------------------------
  // Category colours are arbitrary, so ramps/lines are built in a perceptual space:
  // hue is kept, lightness is chosen for the dark UI, chroma is clipped to the sRGB gamut.
  parseColor(value) {
    let hex = String(value || "").trim().replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(ch => ch + ch).join("");
    if (!/^[0-9a-f]{6}$/i.test(hex)) hex = "999999";
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  }

  toOklch(value) {
    const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = this.parseColor(value).map(lin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(A, B), H: Math.atan2(B, A) };
  }

  fromOklch(L, C, H) {
    const gamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);
    const convert = chroma => {
      const a = chroma * Math.cos(H), b = chroma * Math.sin(H);
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
      ];
    };
    let chroma = C, rgb = convert(chroma);
    const inGamut = v => v.every(c => c >= -0.0005 && c <= 1.0005);
    for (let i = 0; i < 24 && !inGamut(rgb); i += 1) { chroma *= 0.92; rgb = convert(chroma); }
    return "#" + rgb.map(c => Math.round(Math.min(1, Math.max(0, gamma(c))) * 255).toString(16).padStart(2, "0")).join("");
  }

  // Five steps from "barely there" to "bright", same hue, always lighter than the empty cell.
  activityRamp(color) {
    const { C, H } = this.toOklch(color);
    const grey = C < 0.03;                       // near-grey categories stay neutral instead of inventing a hue
    const chroma = grey ? C : Math.min(0.17, Math.max(0.09, C));
    return [[0.36, 0.55], [0.48, 0.8], [0.6, 1], [0.72, 1], [0.84, 0.85]]
      .map(([L, k]) => this.fromOklch(L, chroma * k, H));
  }

  // The category colour for thin lines on the dark UI: untouched when already readable.
  readableColor(color) {
    const { L, C, H } = this.toOklch(color);
    if (L >= 0.62) return this.fromOklch(L, C, H);
    return this.fromOklch(0.68, Math.max(C, 0.1), H);
  }

  renderActivityCalendar(now = Date.now()) {
    const currentYear = new Date(now).getFullYear();

    // --- 1. NEW: Populate the Category Dropdown ---
    const catOptions = [`<option value="all">All categories</option>`];
    this.store.state.categories.forEach(c => catOptions.push(`<option value="${this.escape(c.id)}">${this.escape(c.name)}</option>`));
    this.elements.activityCategoryFilter.innerHTML = catOptions.join("");
    this.elements.activityCategoryFilter.value = this.selectedActivityCategory;
    this.elements.activityCategoryFilter.onchange = (e) => {
      this.selectedActivityCategory = e.target.value;
      this.renderActivityCalendar(); // Re-render immediately when changed
    };

    const selectedCategoryObj = this.store.state.categories.find(c => c.id === this.selectedActivityCategory);
    // One perceptual ramp per category (see activityRamp); "All categories" uses the default green.
    this.activityRamp(selectedCategoryObj?.color || "#39d353").forEach((color, index) => {
      this.elements.activityCard.style.setProperty(`--level-${index + 1}`, color);
    });

    // --- 2. Existing Year Logic ---
    const availableYears = new Set(Array.from({ length: 10 }, (_, index) => currentYear - index));
    this.store.state.tasks.forEach(task => {
      this.taskSessions(task, now).forEach(session => {
        const start = new Date(session.start).getTime();
        if (Number.isFinite(start)) {
          const sessionYear = new Date(start).getFullYear();
          if (sessionYear < currentYear) availableYears.add(sessionYear);
        }
      });
    });
    const earliestYear = Math.max(currentYear - 99, Math.min(...availableYears));
    const years = Array.from({ length: currentYear - earliestYear + 1 }, (_, index) => currentYear - index);
    if (!years.includes(this.selectedActivityYear)) this.selectedActivityYear = currentYear;
    this.elements.activityYear.innerHTML = years
      .map(year => `<option value="${year}"${year === this.selectedActivityYear ? " selected" : ""}>${year}</option>`)
      .join("");
    this.elements.activityYear.onchange = () => {
      this.selectedActivityYear = Number(this.elements.activityYear.value);
      const [currentYear, month, day] = this.selectedDate.split("-").map(Number);
      if (currentYear !== this.selectedActivityYear) {
        const selected = new Date(this.selectedActivityYear, month - 1, day);
        if (selected.getMonth() !== month - 1) selected.setDate(0);
        this.selectedDate = this.dateKey(selected);
        this.calendarMonth = new Date(this.selectedActivityYear, selected.getMonth(), 1);
        this.calendarAutoScrollPending = true;
        this.render();
      } else {
        this.renderActivityCalendar(now);
      }
    };

    // --- 3. Existing Date Setup ---
    const year = this.selectedActivityYear;
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const firstWeek = new Date(yearStart);
    firstWeek.setDate(firstWeek.getDate() - ((firstWeek.getDay() + 6) % 7));
    const weekCount = Math.ceil((yearEnd.getTime() - firstWeek.getTime()) / (7 * 24 * 60 * 60 * 1000));
    const dateKeys = [];
    const totals = new Map();
    for (let day = 0; day < weekCount * 7; day += 1) {
      const date = new Date(firstWeek);
      date.setDate(firstWeek.getDate() + day);
      dateKeys.push(date >= yearStart && date < yearEnd ? this.dateKey(date) : null);
      if (date >= yearStart && date < yearEnd) totals.set(this.dateKey(date), 0);
    }

    // --- 4. Calculate Totals with NEW Category Filter ---
    const rangeEnd = yearEnd.getTime();
    this.store.state.tasks.forEach(task => {
      // THE NEW FILTER: Skip this task if a specific category is selected and it doesn't match
      if (this.selectedActivityCategory !== "all" && task.category !== this.selectedActivityCategory) return;

      const sessions = this.taskSessions(task, now);
      sessions.forEach(session => {
        const start = new Date(session.start).getTime();
        const end = new Date(session.end).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        let cursor = Math.max(start, yearStart.getTime());
        while (cursor < end && cursor < rangeEnd) {
          const date = new Date(cursor);
          const key = this.dateKey(date);
          const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
          const overlap = Math.min(end, nextDay, rangeEnd) - cursor;
          if (totals.has(key) && overlap > 0) totals.set(key, totals.get(key) + overlap);
          cursor += overlap;
        }
      });
    });

    const levelFor = milliseconds => {
      if (milliseconds <= 0) return 0;
      if (milliseconds < 30 * 60 * 1000) return 1;          // Up to 30m
      if (milliseconds < 2 * 60 * 60 * 1000) return 2;      // 30m to 2h
      if (milliseconds < 5 * 60 * 60 * 1000) return 3;      // 2h to 5h
      if (milliseconds < 8 * 60 * 60 * 1000) return 4;      // 5h to 8h
      return 5;                                             // 8h+
    };

    // --- 5. Render Grid with NEW Dynamic Colors ---
    this.elements.activityGrid.innerHTML = dateKeys.map(date => {
      if (!date) return '<span class="activity-cell activity-padding" aria-hidden="true"></span>';
      const milliseconds = totals.get(date);
      const level = levelFor(milliseconds);
      
      return `<button class="activity-cell" type="button" data-activity-date="${date}" data-level="${level}" aria-label="${this.escape(this.formatTaskDate(date))}: ${this.escape(this.duration(milliseconds))} focus time" aria-pressed="${date === this.selectedDate}" title="${this.escape(this.formatTaskDate(date))}: ${this.escape(this.duration(milliseconds))}"></button>`;
    }).join("");

    // --- 6. Existing Month Labels & Bindings ---
    const monthLabels = [];
    for (let month = 0; month < 12; month += 1) {
      const monthStart = new Date(year, month, 1);
      const week = Math.floor((monthStart.getTime() - firstWeek.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
      monthLabels.push(`<span style="grid-column:${week}">${monthStart.toLocaleDateString([], { month: "short" })}</span>`);
    }
    this.elements.activityMonths.style.setProperty("--activity-weeks", String(weekCount));
    this.elements.activityGrid.style.setProperty("--activity-weeks", String(weekCount));
    this.elements.activityMonths.innerHTML = monthLabels.join("");
    
    this.elements.activityGrid.querySelectorAll("[data-activity-date]").forEach(button => {
      button.onclick = () => this.selectActivityDate(button.dataset.activityDate);
    });
    
    this.elements.activityTrendRange.value = this.selectedActivityRange;
    this.elements.activityTrendRange.onchange = () => {
      this.selectedActivityRange = this.elements.activityTrendRange.value;
      this.renderActivityTrend(now);
    };
    this.renderActivityTrend(now);
  }

  renderActivityTrend(now = Date.now()) {
    // 1. Populate the Multi-Select Checkboxes (Max 5)
    if (this.selectedTrendCategories.length === 0 && this.store.state.categories.length > 0) {
      this.selectedTrendCategories = this.store.state.categories.slice(0, 5).map(c => c.id);
    }

    this.elements.trendMultiCount.textContent = `(${this.selectedTrendCategories.length}/5)`;
    
    this.elements.trendMultiContent.innerHTML = this.store.state.categories.map(category => {
      const checked = this.selectedTrendCategories.includes(category.id);
      const isMax = this.selectedTrendCategories.length >= 5;
      const disabled = !checked && isMax;
      
      return `<label class="${disabled ? "disabled" : ""}">
        <input type="checkbox" value="${category.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
        ${this.escape(category.name)}
      </label>`;
    }).join("");

    // Bind checkbox events
    this.elements.trendMultiContent.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = (e) => {
        const id = e.target.value;
        if (e.target.checked) {
          if (this.selectedTrendCategories.length < 5) this.selectedTrendCategories.push(id);
        } else {
          this.selectedTrendCategories = this.selectedTrendCategories.filter(cId => cId !== id);
        }
        this.renderActivityTrend(now);
      };
    });

    // 2. Existing Date/Bucket Logic
    const selectedDate = this.selectedDate.split("-").map(Number);
    const selectedYear = this.selectedActivityYear;
    const anchorDate = selectedDate[0] === selectedYear
      ? new Date(selectedDate[0], selectedDate[1] - 1, selectedDate[2])
      : new Date(selectedYear, 0, 1);
    const buckets = [];
    if (this.selectedActivityRange === "daily") {
      for (let hour = 0; hour < 24; hour += 1) {
        const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(), hour);
        const end = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(), hour + 1);
        buckets.push({ start, end, label: String(hour).padStart(2, "0") });
      }
    } else if (this.selectedActivityRange === "weekly") {
      const startOfWeek = new Date(anchorDate);
      startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
      for (let day = 0; day < 7; day += 1) {
        const start = new Date(startOfWeek);
        start.setDate(start.getDate() + day);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        buckets.push({ start, end, label: start.toLocaleDateString([], { weekday: "short" }) });
      }
    } else if (this.selectedActivityRange === "monthly") {
      const year = anchorDate.getFullYear();
      const month = anchorDate.getMonth();
      const days = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= days; day += 1) {
        buckets.push({ start: new Date(year, month, day), end: new Date(year, month, day + 1), label: String(day) });
      }
    } else {
      for (let month = 0; month < 12; month += 1) {
        buckets.push({
          start: new Date(selectedYear, month, 1),
          end: new Date(selectedYear, month + 1, 1),
          label: new Date(selectedYear, month, 1).toLocaleDateString([], { month: "short" })
        });
      }
    }

    // 3. Calculate Points per Category
    const categoryPoints = {}; // { catId: [{x, y, ms, ...bucket}] }
    
    // Initialize arrays
    this.selectedTrendCategories.forEach(id => categoryPoints[id] = []);
    
    buckets.forEach(bucket => {
      const timeWindowStart = bucket.start.getTime();
      const timeWindowEnd = bucket.end.getTime();
      
      this.selectedTrendCategories.forEach(catId => {
        const ms = this.focusDurationBetween(timeWindowStart, timeWindowEnd, now, catId); // We'll update focusDurationBetween
        categoryPoints[catId].push({ ...bucket, milliseconds: ms });
      });
    });

    // 4. Find Max Y-Value across ALL selected categories
    let maxValue = 0;
    this.selectedTrendCategories.forEach(catId => {
      categoryPoints[catId].forEach(p => {
        if (p.milliseconds > maxValue) maxValue = p.milliseconds;
      });
    });

    const activePoints = Object.values(categoryPoints).flat().filter(p => p.milliseconds > 0).length;
    if (activePoints < 2) {
      this.elements.activityTrendChart.innerHTML = '<p class="focus-trend-empty">Not enough data</p>';
      return;
    }

    // 5. Chart Dimensions
    const width = 640;
    const height = 210;
    const left = 48;
    const right = 14;
    const top = 14;
    const bottom = 35;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    
    const yMax = Math.ceil(maxValue / (60 * 60 * 1000)) * 60 * 60 * 1000 || maxValue;

    // 6. Generate Polylines
    const polylines = this.selectedTrendCategories.map(catId => {
      const category = this.store.state.categories.find(c => c.id === catId);
      if (!category) return "";

      const lineColor = this.readableColor(category.color);
      const points = categoryPoints[catId].map((point, index) => ({
        ...point,
        x: left + (index / Math.max(1, categoryPoints[catId].length - 1)) * chartWidth,
        y: top + chartHeight - (point.milliseconds / yMax) * chartHeight
      }));

      const line = points.map(p => `${p.x},${p.y}`).join(" ");
      const circles = points.map(p =>
        `<circle class="trend-point" style="fill: ${lineColor}; stroke: var(--card);" cx="${p.x}" cy="${p.y}" r="3"><title>${this.escape(category.name)} ${this.escape(p.label)}: ${this.escape(this.duration(p.milliseconds))}</title></circle>`
      ).join("");

      return `
        <polyline class="trend-line" style="stroke: ${lineColor};" points="${line}"></polyline>
        ${circles}
      `;
    }).join("");

    // 7. Labels & Axes (keep existing logic)
    const labelIndexes = new Set([0, Math.round((buckets.length - 1) / 4), Math.round((buckets.length - 1) / 2), Math.round((buckets.length - 1) * 3 / 4), buckets.length - 1]);
    const yTicks = [0, yMax / 2, yMax];
    const formatAxisDuration = milliseconds => {
      const hours = milliseconds / (60 * 60 * 1000);
      if (hours >= 1) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
      return `${Math.round(milliseconds / 60000)}m`;
    };
    const rangeLabel = this.selectedActivityRange[0].toUpperCase() + this.selectedActivityRange.slice(1);
    const periodCaption = this.selectedActivityRange === "daily"
      ? this.formatTaskDate(this.dateKey(anchorDate))
      : this.selectedActivityRange === "weekly"
        ? `${this.formatTaskDate(this.dateKey(buckets[0].start))} – ${this.formatTaskDate(this.dateKey(buckets[buckets.length - 1].start))}`
        : this.selectedActivityRange === "monthly"
          ? anchorDate.toLocaleDateString([], { month: "long", year: "numeric" })
          : String(selectedYear);

    const axis = yTicks.map(value => {
      const y = top + chartHeight - (value / yMax) * chartHeight;
      return `<g class="trend-y-tick"><line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line><text x="${left - 8}" y="${y + 4}" text-anchor="end">${formatAxisDuration(value)}</text></g>`;
    }).join("");
    
    const xLabels = buckets.map((bucket, index) => {
      if (!labelIndexes.has(index)) return "";
      const x = left + (index / Math.max(1, buckets.length - 1)) * chartWidth;
      return `<text class="trend-x-label" x="${x}" y="${height - 12}" text-anchor="middle">${this.escape(bucket.label)}</text>`;
    }).join("");

    // 8. Render SVG
    this.elements.activityTrendChart.innerHTML = `
      <div class="focus-trend-caption">${rangeLabel} focus time · ${this.escape(periodCaption)}</div>
      <svg class="focus-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${rangeLabel} focus time trend">
        ${axis}
        ${polylines}
        ${xLabels}
      </svg>`;
  }

  focusDurationBetween(startTime, endTime, now = Date.now(), categoryId = null) {
    const clippedEnd = Math.min(endTime, now);
    if (clippedEnd <= startTime) return 0;
    
    return this.store.state.tasks
      .filter(task => categoryId ? task.category === categoryId : true)
      .reduce((total, task) => total + this.taskSessions(task, now).reduce((taskTotal, session) => {
        const sessionStart = new Date(session.start).getTime();
        const sessionEnd = new Date(session.end).getTime();
        if (!Number.isFinite(sessionStart) || !Number.isFinite(sessionEnd) || sessionEnd <= sessionStart) return taskTotal;
        return taskTotal + Math.max(0, Math.min(sessionEnd, clippedEnd) - Math.max(sessionStart, startTime));
      }, 0), 0);
  }

  focusDurationOnDate(task, dateKey, now = Date.now()) {
    if (!this.isDateKey(dateKey)) return 0;
    const [year, month, day] = dateKey.split("-").map(Number);
    const dayStart = new Date(year, month - 1, day).getTime();
    const dayEnd = new Date(year, month - 1, day + 1).getTime();
    return this.taskSessions(task, now).reduce((total, session) => {
      const start = new Date(session.start).getTime();
      const end = new Date(session.end).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return total;
      return total + Math.max(0, Math.min(end, dayEnd) - Math.max(start, dayStart));
    }, 0);
  }

  taskMarkup(task, focusWidget = false) {
    const active = this.store.state.active === task.id;
    const taskCategory = this.store.state.categories.find(item => item.id === task.category);
    const category = taskCategory?.name || "";
    const categoryColor = taskCategory?.color || "#999";
    const priority = task.priority || "medium";
    
    const onBreak = active && this.store.state.pomodoro?.phase === "break";
    const status = onBreak
      ? "On break"
      : active
        ? "In progress"
        : task.done
          ? "Complete"
          : task.start
            ? "Paused"
            : "Not started";
    const classes = `${active ? "active " : ""}${task.done ? "done" : ""}`; 
    const durationMs = this.taskDuration(task);
    const timer = active && !onBreak
      ? `<div class="timer">${this.duration(durationMs)}</div>`
      : "";
    const sessionButton = active
      ? `<button class="ui-button stop" data-action="session" title="Stop task" aria-label="Stop ${this.escape(task.name)}"><img src="icons/pause.svg" alt="Stop"></button>`
      : `<button class="ui-button" data-action="session" title="Start task" aria-label="Start ${this.escape(task.name)}"><img src="icons/play.svg" alt="Start"></button>`;

    return `<div class="task-row"><div class="task ${classes}" data-task-id="${this.escape(task.id)}" data-priority="${priority}" draggable="true" style="--category-color:${this.escape(categoryColor)}">
        <div class="check" data-action="toggle">
        </div>
        <div class="task-main">
          <div class="task-name"><span class="task-priority-dot" aria-hidden="true"></span><span class="task-name-text">${this.escape(task.name)}</span></div>
          ${category ? `<div class="category">${this.escape(category)}</div>` : ""}
        </div>
          ${this.etaMarkup(task)}${timer}<div class="task-actions">${sessionButton}</div>
        </div><div class="task-details" data-task-id="${this.escape(task.id)}" hidden>${this.taskDetailsMarkup(task)}</div></div>`;
  }

  taskDetailsMarkup(task, isNew = false) {
    const sessions = this.taskSessions(task);
    const sessionList = sessions.length
      ? `<ol>${sessions.map(session => {
          const start = new Date(session.start).getTime();
          const end = new Date(session.end).getTime();
          if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
          return `<li><span>${this.formatDateTime(start)} – ${this.formatDateTime(end)}</span><strong>${this.duration(this.elapsed(start, end))}</strong></li>`;
        }).join("")}</ol>`
      : '<span class="task-no-sessions">No focus sessions recorded</span>';
      
    const estimateMinutes = Number.isFinite(task.estimateMs) && task.estimateMs > 0 ? Math.round(task.estimateMs / 60000) : "";
    const completionTime = task.done
      ? task.completedAt ? this.formatDateTime(task.completedAt) : "Time not recorded"
      : "—";
      
    const priority = task.priority || "medium";
    const hasCategory = this.store.state.categories.some(cat => cat.id === task.category);
    const categoryOptions = [
      hasCategory ? "" : '<option value="" selected>Uncategorized</option>',
      ...this.store.state.categories.map(cat =>
        `<option value="${this.escape(cat.id)}"${cat.id === task.category ? " selected" : ""}>${this.escape(cat.name)}</option>`
      )
    ].join("");

    return `<div class="task-detail-head">
        ${isNew ? '' : `<button class="task-detail-check${task.done ? " is-done" : ""}" type="button" data-action="toggle-draft" aria-label="${task.done ? "Mark incomplete" : "Mark complete"}"></button>`}
        <input class="ui-field task-detail-name" type="text" value="${this.escape(task.name)}" aria-label="Task name" autocomplete="off" placeholder="What needs your focus?">
        ${isNew ? '' : `<button class="task-detail-delete" type="button" data-action="delete" aria-label="Delete task" title="Delete task">
          <img src="icons/trash.svg" alt="">
        </button>`}
      </div>
      <div class="task-detail-fields">
        <label class="task-detail-field">
          <span>Planned date</span>
          <input type="date" class="ui-field task-detail-date" value="${this.escape(task.date || "")}">
        </label>
        <label class="task-detail-field">
          <span>Category</span>
          <select class="ui-control task-detail-category">${categoryOptions}</select>
        </label>
        <label class="task-detail-field">
          <span>Priority</span>
          <select class="ui-control task-detail-priority">
            <option value="high"${priority === "high" ? " selected" : ""}>High priority</option>
            <option value="medium"${priority === "medium" ? " selected" : ""}>Medium priority</option>
            <option value="low"${priority === "low" ? " selected" : ""}>Low priority</option>
          </select>
        </label>
        <label class="task-detail-field">
          <span>Estimated time (min)</span>
          <input type="number" class="ui-field task-detail-estimate" min="1" max="1440" step="1" inputmode="numeric" placeholder="None" value="${estimateMinutes}">
        </label>
      </div>

      ${isNew ? '' : `
      <dl class="task-properties task-meta">
        <div><dt>Created</dt><dd>${this.escape(this.formatDateTime(task.created))}</dd></div>
        <div><dt>Completed at</dt><dd>${this.escape(completionTime)}</dd></div>
        ${task.raindropsEarned ? `<div><dt>Raindrops earned</dt><dd>${task.raindropsEarned}</dd></div>` : ""}
      </dl>
      `}
      
      ${isNew ? '' : `
      <details class="task-detail-sessions">
        <summary>
          <span>Focus sessions</span>
          <span class="task-detail-sessions-total">${this.duration(this.taskDuration(task))}</span>
        </summary>
        <dl class="task-properties">
          <div class="task-session-property"><dt>Sessions</dt><dd>${sessionList}</dd></div>
        </dl>
      </details>
      `}

      <div class="task-detail-footer">
        <button class="ui-control" type="button" data-action="cancel">Cancel</button>
        <button class="ui-control" type="button" data-action="save">${isNew ? "Add task" : "Save"}</button>
      </div>`;
  }

  taskSessions(task, now = Date.now()) {
    const sessions = Array.isArray(task.sessions)
      ? [...task.sessions]
      : task.start && task.end
        ? [{ start: task.start, end: task.end }]
        : [];
    if (this.store.state.active === task.id && task.start && !task.end) {
      sessions.push({ start: task.start, end: new Date(now).toISOString() });
    }
    return sessions;
  }

  dateOptionsMarkup(selectedValue = this.selectedDate || this.today()) {
    return this.dateOptions().map(option => `<option value="${this.escape(option.value)}"${option.value === selectedValue ? " selected" : ""}>${this.escape(option.label)}</option>`).join("");
  }

  bindTaskEvents(container = this.elements.tasks) {
    container.querySelectorAll(".task[data-task-id]").forEach(taskElement => {
      const taskId = taskElement.dataset.taskId;
      taskElement.ondragstart = event => {
        if (event.target.closest("button, input, select, [data-action]")) {
          event.preventDefault();
          return;
        }
        this.beginTaskDrag(event, taskId, taskElement);
      };
      taskElement.onclick = event => {
        if (event.target.closest("button, input, select, .check")) return;
        // The details modal lives in the main window, so rows shown inside the PiP window don't open it.
        if (taskElement.ownerDocument !== this.document) return;
        const taskRow = taskElement.closest(".task-row");
        
        // If this task is already the one open, close it
        if (this.expandedTaskId === taskId) {
          this.closeTaskModal();
          return;
        }

        // If a different task is open, close it first
        if (this.expandedTaskId) {
          this.closeTaskModal();
        }

        // Open the clicked task
        const details = taskRow?.querySelector(".task-details");
        if (!details) return;
        
        taskRow.classList.add("is-expanded");
        const modal = this.document.getElementById("taskModal");
        
        modal.innerHTML = "";
        modal.appendChild(details);
        modal.hidden = false;
        details.hidden = false;
        
        // Save the exact row we clicked
        this.activeTaskRow = taskRow; 
        this.expandedTaskId = taskId;
      };
      taskElement.ondragend = () => taskElement.classList.remove("is-dragging");
      const toggle = taskElement.querySelector('[data-action="toggle"]');
      if (toggle) toggle.onclick = () => this.toggleDone(taskId);
      const session = taskElement.querySelector('[data-action="session"]');
      if (session) session.onclick = () => {
        if (this.store.state.active === taskId) this.stopTask();
        else this.startTask(taskId);
      };

      const row = taskElement.closest(".task-row");
      const details = row?.querySelector(".task-details");
      if (details) this.bindTaskDetailsEvents(details, taskId);
    });
  }

  bindTaskDetailsEvents(details, taskId, isNew = false) {
    const task = isNew ? null : this.store.findTask(taskId);
    if (!isNew && !task) return;

    const check = details.querySelector('[data-action="toggle-draft"]');
    if (check) {
      check.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        check.classList.toggle("is-done");
      };
    }

    const deleteBtn = details.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.deleteTask(taskId);
        this.closeTaskModal();
      };
    }

    const cancelBtn = details.querySelector('[data-action="cancel"]');
    if (cancelBtn) {
      cancelBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeTaskModal();
      };
    }

    const saveBtn = details.querySelector('[data-action="save"]');
    if (saveBtn) {
      saveBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const newName = details.querySelector(".task-detail-name").value.trim();
        if (!newName) {
          details.querySelector(".task-detail-name").focus();
          return; // Prevent empty tasks
        }

        const newDate = details.querySelector(".task-detail-date").value;
        const newCategory = details.querySelector(".task-detail-category").value;
        const newPriority = details.querySelector(".task-detail-priority").value;
        const estimateMinutes = Number(details.querySelector(".task-detail-estimate").value);
        const newEstimateMs = Number.isFinite(estimateMinutes) && estimateMinutes >= 1
          ? Math.min(1440, Math.round(estimateMinutes)) * 60 * 1000
          : undefined;

        if (isNew) {
          // Create new task
          this.store.addTask({
            id: crypto.randomUUID(),
            name: newName,
            category: newCategory,
            priority: newPriority,
            date: this.isDateKey(newDate) ? newDate : this.today(),
            created: Date.now(),
            sessions: [],
            done: false,
            estimateMs: newEstimateMs
          });
        } else {
          // Update existing task
          task.name = newName;
          if (this.isDateKey(newDate)) task.date = newDate;
          task.category = newCategory;
          task.priority = newPriority;
          if (newEstimateMs) {
            task.estimateMs = newEstimateMs;
            delete task.estimateSkipped;
          } else {
            delete task.estimateMs;
          }
          this.store.save();

          const isDone = details.querySelector('[data-action="toggle-draft"]').classList.contains("is-done");
          if (isDone && !task.done) {
            this.closeTaskModal();
            this.completeTask(task);         // same flow as clicking the checkmark
            return;
          }
          if (!isDone && task.done) {
            task.done = false;
            task.completedAt = undefined;
            this.store.save();
          }
        }
        
        this.closeTaskModal(); 
      };
    }
  }

  updateTaskNameDisplay(taskId, name) {
    this.document.querySelectorAll(`.task[data-task-id="${taskId}"] .task-name-text`).forEach(el => {
      el.textContent = name;
    });
    this.document.querySelectorAll(`.task-details[data-task-id="${taskId}"] .task-detail-name`).forEach(el => {
      if (el !== document.activeElement) el.value = name;
    });
  }

  deleteTask(id) {
    const task = this.store.findTask(id);
    if (!task) return;
    if (!window.confirm(`Delete "${task.name}"?`)) return;
    if (this.store.state.active === id) this.stopTask(false, false);
    this.store.state.tasks = this.store.state.tasks.filter(t => t.id !== id);
    if (this.expandedTaskId === id) this.expandedTaskId = null;
    this.store.save();
    this.render();
  }

  categoryOptions(selectedCategory = "") {
    return this.store.state.categories
      .map(category => `<option value="${this.escape(category.id)}"${category.id === selectedCategory ? " selected" : ""}>${this.escape(category.name)}</option>`)
      .join("");
  }

  colorPickerValue(color) {
    return /^#[0-9a-f]{6}$/i.test(color) ? color : "#888888";
  }

  editTask(id, sourceElement = this.elements.tasks) {
    const editingFocusTask = this.elements.focusTasks.contains(sourceElement);
    this.editingTaskId = id;
    this.renderTasks(true);
    const editContainer = editingFocusTask ? this.elements.focusTasks : this.elements.tasks;
    const editName = editContainer.querySelector(".edit-name")
      || (editingFocusTask ? this.elements.tasks : this.elements.focusTasks).querySelector(".edit-name");
    editName?.focus();
    editName?.select();
  }

  saveTaskEdits(id, taskElement) {
    const task = this.store.findTask(id);
    const name = taskElement.querySelector(".edit-name").value.trim();
    if (!task || !name) return;
    task.name = name;
    task.category = taskElement.querySelector(".edit-category").value;
    task.date = taskElement.querySelector(".edit-date").value;
    this.store.save();
    this.editingTaskId = null;
    this.render();
  }

  cancelTaskEdit() {
    this.editingTaskId = null;
    this.renderTasks();
  }

  addCategory() {
    const field = this.elements.newCategoryName;
    const cleanName = field.value.trim();
    if (!cleanName) { field.focus(); return; }
    const id = `${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const color = this.randomColor();
    this.store.addCategory({ id, name: cleanName, color });
    field.value = "";
    this.selectedCategory = id;
    this.render();
  }















  startTask(id) {
    this.closeFocusTasks();   // the popout would otherwise sit on top of the start countdown
    const task = this.store.findTask(id);
    if (!task) return;
    if (this.store.state.active === id) return;
    if (this.countdown?.taskId === id) return;   // already counting down for this one
    this.dismissCelebration();
    // First start of a task: ask how long it will take (skipped once answered, or when set in the details).
    if (!Number.isFinite(task.estimateMs) && !task.estimateSkipped) {
      this.openEtaPrompt(id);
      return;
    }
    this.beginCountdown(id);
  }

  /* --- Estimate prompt (an overlay in the clock panel, so it also works inside PiP) ------------ */

  openEtaPrompt(id) {
    const task = this.store.findTask(id);
    if (!task) return;
    this.etaPrompt = { taskId: id };
    this.elements.etaTaskName.textContent = task.name;
    this.elements.etaMinutes.value = "";
    this.elements.etaDisplay.hidden = false;
    this.elements.centerStage.dataset.etaState = "active";
  }

  closeEtaPrompt() {
    this.etaPrompt = null;
    this.elements.etaDisplay.hidden = true;
    this.elements.centerStage.dataset.etaState = "";
  }

  // minutes = null means "no estimate": the task starts, and we don't ask again.
  chooseEta(minutes) {
    const task = this.etaPrompt ? this.store.findTask(this.etaPrompt.taskId) : null;
    this.closeEtaPrompt();
    if (!task) return;
    if (minutes) {
      task.estimateMs = minutes * 60 * 1000;
      delete task.estimateSkipped;
    } else {
      task.estimateSkipped = true;
    }
    this.store.save();
    this.beginCountdown(task.id);
  }

  /* --- ETA: when will this task be done, breaks included ---------------------------------------- */

  // Wall-clock time the task should be finished, simulating the pomodoro cycle: every focus
  // phase that fills up is followed by a break before the remaining focus time continues.
  etaFinishAt(task, now = Date.now()) {
    const estimate = task.estimateMs;
    if (!Number.isFinite(estimate) || estimate <= 0) return null;
    let remaining = estimate - this.taskDuration(task, now);
    if (remaining <= 0) return null;
    const focusMs = this.focusDurationMs();
    const breakMs = this.breakDurationMs();
    let time = now;
    let workLeft = focusMs;
    const pomodoro = this.store.state.pomodoro;
    if (pomodoro && this.store.state.active === task.id) {
      const left = pomodoro.paused && Number.isFinite(pomodoro.remainingMs)
        ? pomodoro.remainingMs
        : Math.max(0, pomodoro.phaseEndsAt - now);
      if (pomodoro.phase === "break") time += left;          // wait out the current break first
      else if (left > 0) workLeft = left;
    }
    for (let guard = 0; remaining > workLeft && guard < 1000; guard += 1) {
      remaining -= workLeft;
      time += workLeft + breakMs;
      workLeft = focusMs;
    }
    return time + remaining;
  }

  etaText(task, now = Date.now()) {
    if (!Number.isFinite(task.estimateMs) || task.estimateMs <= 0 || task.done) return "";
    if (this.store.state.active !== task.id) return `Est ${this.shortDuration(task.estimateMs)}`;
    const finishAt = this.etaFinishAt(task, now);
    return finishAt ? `ETA ${this.formatTime(finishAt)}` : "Over estimate";
  }

  etaMarkup(task) {
    const text = this.etaText(task);
    return text ? `<div class="eta" title="Estimated time: ${this.escape(this.shortDuration(task.estimateMs))}">${this.escape(text)}</div>` : "";
  }

  shortDuration(milliseconds) {
    const totalMinutes = Math.round(Math.max(0, milliseconds) / 60000);
    if (totalMinutes < 1) return `${Math.round(Math.max(0, milliseconds) / 1000)}s`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes}m`;
    return minutes ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${hours}h`;
  }

  /* --- Completing a task: raindrops, streak and the celebration --------------------------------- */

  raindropsFor(focusedMs, estimateMs) {
    const rules = FocusApp.RAINDROPS;
    const ratio = focusedMs / estimateMs;
    if (ratio < rules.onTargetBand[0]) return { tier: "faster", amount: rules.faster };
    if (ratio <= rules.onTargetBand[1]) return { tier: "on-target", amount: rules.base };
    return { tier: "slower", amount: rules.slower };
  }

  // Consecutive days with at least one completed task.
  bumpStreak() {
    const streak = this.store.state.streak;
    const today = this.today();
    if (streak.lastDate !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      streak.count = streak.lastDate === this.dateKey(yesterday) ? streak.count + 1 : 1;
      streak.lastDate = today;
    }
    return streak.count;
  }

  currentStreak() {
    const { count, lastDate } = this.store.state.streak;
    if (!lastDate) return 0;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return lastDate === this.today() || lastDate === this.dateKey(yesterday) ? count : 0;
  }

  completeTask(task) {
    if (this.store.state.active === task.id) this.stopTask(false);   // a finished task stops its timer
    task.done = true;
    task.completedAt = new Date().toISOString();
    const focusedMs = this.taskDuration(task);
    const estimateMs = Number.isFinite(task.estimateMs) && task.estimateMs > 0 ? task.estimateMs : null;
    const streak = this.bumpStreak();

    let reward = null;
    let note = "";
    if (task.raindropsEarned) note = "Raindrops already earned for this task";
    else if (!estimateMs) note = "Set an estimate to earn raindrops";
    else if (focusedMs < FocusApp.RAINDROPS.minFocusMs) note = "Focus a little longer to earn raindrops";
    else {
      reward = this.raindropsFor(focusedMs, estimateMs);
      task.raindropsEarned = reward.amount;
      this.store.state.raindrops = (this.store.state.raindrops || 0) + reward.amount;
    }
    this.store.save();
    this.render();
    this.showCelebration({ focusedMs, estimateMs, reward, note, streak });
  }

  showCelebration({ focusedMs, estimateMs, reward, note, streak }) {
    const phrases = {
      faster: ["Bravo!", "Brilliant!", "Crushed it!"],
      "on-target": ["Well done!", "Right on time!", "Spot on!"],
      slower: ["Task done!", "Nice work!", "Finished!"],
      none: ["Well done!", "Nice work!", "Task done!"]
    }[reward?.tier || (estimateMs && focusedMs >= estimateMs * FocusApp.RAINDROPS.onTargetBand[1] ? "slower" : "none")];
    let compare = focusedMs ? `Focused for ${this.shortDuration(focusedMs)}` : "";
    if (estimateMs && focusedMs) {
      const difference = focusedMs - estimateMs;
      const verdict = Math.abs(difference) < 60000
        ? "right on your estimate"
        : difference < 0 ? `${this.shortDuration(-difference)} faster` : `${this.shortDuration(difference)} over`;
      compare = `Estimated ${this.shortDuration(estimateMs)} · Took ${this.shortDuration(focusedMs)} · ${verdict}`;
    }
    const title = this.elements.celebrateTitle;
    title.textContent = phrases[Math.floor(Math.random() * phrases.length)];
    title.classList.remove("countdown-pop");
    void title.offsetWidth;
    title.classList.add("countdown-pop");
    this.elements.celebrateCompare.textContent = compare;
    this.elements.celebrateDrops.textContent = reward ? `+${reward.amount} raindrops` : note;
    this.elements.celebrateDrops.classList.toggle("is-note", !reward);
    this.elements.celebrateStreak.textContent = streak > 1 ? `${streak}-day streak` : "Streak started";
    this.elements.celebrateDisplay.hidden = false;
    this.elements.centerStage.dataset.celebrateState = "active";
    this.playCountdownTick(true);
    window.clearTimeout(this.celebrationTimer);
    this.celebrationTimer = window.setTimeout(() => this.dismissCelebration(), FocusApp.CELEBRATION_MS);
  }

  dismissCelebration() {
    window.clearTimeout(this.celebrationTimer);
    this.celebrationTimer = null;
    this.elements.celebrateDisplay.hidden = true;
    this.elements.centerStage.dataset.celebrateState = "";
  }

  renderStats() {
    this.elements.raindropCount.textContent = String(this.store.state.raindrops || 0);
    const streak = this.currentStreak();
    this.elements.streakCount.textContent = String(streak);
    this.elements.streakChip.classList.toggle("is-idle", streak === 0);
  }

  /* --- New: countdown helpers ----------------------------------------- */

  beginCountdown(taskId) {
    if (this.countdown) this.clearCountdown();
    const now = Date.now();
    this.countdown = {
      taskId,
      step: 0,
      stepEndsAt: now + 1000,
      endsAt: now + 3500            // 3 · 2 · 1 · GO!
    };
    this.elements.centerStage.dataset.countdownState = "active";
    this.renderCountdown();
    this.playCountdownTick(false);
    this.countdownInterval = window.setInterval(() => this.tickCountdown(), 80);
  }

  tickCountdown() {
    if (!this.countdown) return;
    const now = Date.now();
    const elapsed = 3500 - (this.countdown.endsAt - now);
    const step = elapsed < 1000 ? 0 : elapsed < 2000 ? 1 : elapsed < 3000 ? 2 : 3;
    if (step !== this.countdown.step) {
      this.countdown.step = step;
      this.renderCountdown();
      this.playCountdownTick(step === 3);
    }
    if (now >= this.countdown.endsAt) {
      const taskId = this.countdown.taskId;
      this.clearCountdown();
      this.startTaskNow(taskId);
    }
  }

  renderCountdown() {
    if (!this.countdown) return;
    const steps = ["3", "2", "1", "GO!"];
    const label = steps[Math.min(this.countdown.step, steps.length - 1)];
    const valueEl = this.elements.countdownValue;
    this.elements.countdownDisplay.hidden = false;
    if (valueEl.textContent !== label) {
      valueEl.textContent = label;
      valueEl.classList.toggle("is-go", label === "GO!");
      valueEl.classList.remove("countdown-pop");
      void valueEl.offsetWidth;                 // force reflow so the animation restarts
      valueEl.classList.add("countdown-pop");
    }
  }

  clearCountdown() {
    if (this.countdownInterval) {
      window.clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.countdown = null;
    this.elements.countdownDisplay.hidden = true;
    this.elements.centerStage.dataset.countdownState = "";
    const valueEl = this.elements.countdownValue;
    valueEl.textContent = "";
    valueEl.classList.remove("is-go", "countdown-pop");
  }

  playCountdownTick(isGo = false) {
    const context = this.audioContext || this.unlockAudio();
    if (!context) return;
    const play = () => {
      const start = context.currentTime;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(isGo ? 880 : 620, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.06, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.connect(gain);
      gain.connect(context.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    };
    if (context.state === "running") play();
    else context.resume().then(play).catch(() => {});
  }

  /* --- The original startTask logic, now called after GO! -------------- */
  startTaskNow(id) {
    const now = Date.now();
    this.advancePomodoro(now);
    if (this.store.state.active === id) return;
    if (this.store.state.active) this.stopTask(false, false);

    const task = this.store.findTask(id);
    if (!task) return;
    this.ensureTaskSessions(task);
    const startsPomodoro = !this.store.state.pomodoro;
    if (startsPomodoro) {
      const phaseDurationMs = this.focusDurationMs();
      this.store.state.pomodoro = {
        phase: "work",
        phaseStartedAt: now,
        phaseDurationMs,
        phaseEndsAt: now + phaseDurationMs
      };
    } else {
      this.resumePomodoro(now);
    }
    if (!Number.isFinite(task.accumulatedMs)) {
      task.accumulatedMs = task.start ? this.elapsed(task.start, task.end || now) : 0;
    }
    task.start = new Date(now).toISOString();
    task.end = this.store.state.pomodoro.phase === "break" ? task.start : undefined;
    this.store.state.active = id;
    this.store.save();
    if (startsPomodoro) this.playPhaseSound("work");
    this.totalActiveFocusMs = 0;
    this.lastActiveTick = Date.now();
    this.render();
  }









  advancePomodoro(now) {
    const pomodoro = this.store.state.pomodoro;
    if (!pomodoro || pomodoro.paused || !Number.isFinite(pomodoro.phaseEndsAt) || !Number.isFinite(pomodoro.phaseStartedAt)) return false;
    if (!this.store.state.active || !this.store.findTask(this.store.state.active)) {
      this.pausePomodoro(now);
      return false;
    }

    let phaseChanged = false;
    while (pomodoro.phaseEndsAt <= now) {
      const transitionAt = pomodoro.phaseEndsAt;
      if (pomodoro.phase === "work") {
        this.pauseActiveTask(transitionAt);
        pomodoro.phase = "break";
        pomodoro.phaseStartedAt = transitionAt;
        pomodoro.phaseDurationMs = this.breakDurationMs();
        pomodoro.phaseEndsAt = transitionAt + pomodoro.phaseDurationMs;
        this.playPhaseSound("break");
      } else if (pomodoro.phase === "break") {
        pomodoro.phase = "work";
        pomodoro.phaseStartedAt = transitionAt;
        pomodoro.phaseDurationMs = this.focusDurationMs();
        pomodoro.phaseEndsAt = transitionAt + pomodoro.phaseDurationMs;
        this.resumeActiveTask(transitionAt);
        this.playPhaseSound("work");
      } else {
        this.store.state.pomodoro = null;
        break;
      }
      phaseChanged = true;
    }

    if (phaseChanged) this.store.save();
    return phaseChanged;
  }

  pausePomodoro(at = Date.now()) {
    const pomodoro = this.store.state.pomodoro;
    if (!pomodoro || pomodoro.paused) return;
    const phaseDuration = Number.isFinite(pomodoro.phaseDurationMs)
      ? pomodoro.phaseDurationMs
      : this.phaseDurationMs(pomodoro.phase);
    pomodoro.phaseDurationMs = phaseDuration;
    pomodoro.remainingMs = Math.max(0, Math.min(phaseDuration, pomodoro.phaseEndsAt - at));
    pomodoro.paused = true;
    this.store.save();
  }

  resumePomodoro(at = Date.now()) {
    const pomodoro = this.store.state.pomodoro;
    if (!pomodoro?.paused) return;
    const phaseDuration = Number.isFinite(pomodoro.phaseDurationMs)
      ? pomodoro.phaseDurationMs
      : this.phaseDurationMs(pomodoro.phase);
    const savedRemaining = Number.isFinite(pomodoro.remainingMs)
      ? pomodoro.remainingMs
      : pomodoro.phaseEndsAt - at;
    const remaining = Math.max(0, Math.min(phaseDuration, savedRemaining));
    if (remaining === 0) {
      pomodoro.phase = pomodoro.phase === "break" ? "work" : "break";
      pomodoro.phaseDurationMs = this.phaseDurationMs(pomodoro.phase);
      pomodoro.phaseStartedAt = at;
      pomodoro.phaseEndsAt = at + pomodoro.phaseDurationMs;
      pomodoro.paused = false;
      delete pomodoro.remainingMs;
      this.playPhaseSound(pomodoro.phase);
      this.store.save();
      return;
    }
    pomodoro.phaseDurationMs = phaseDuration;
    pomodoro.phaseStartedAt = at - (phaseDuration - remaining);
    pomodoro.phaseEndsAt = at + remaining;
    pomodoro.paused = false;
    delete pomodoro.remainingMs;
    this.store.save();
  }

  pauseActiveTask(at) {
    const task = this.store.findTask(this.store.state.active);
    if (!task || task.end) return;
    if (!Number.isFinite(task.accumulatedMs)) task.accumulatedMs = 0;
    const end = new Date(at).toISOString();
    if (task.start) task.accumulatedMs += this.elapsed(task.start, at);
    this.recordTaskSession(task, end);
    task.end = end;
  }

  resumeActiveTask(at) {
    const task = this.store.findTask(this.store.state.active);
    if (!task || !task.end) return;
    if (!Number.isFinite(task.accumulatedMs)) task.accumulatedMs = 0;
    task.start = new Date(at).toISOString();
    task.end = undefined;
  }

  stopTask(redraw = true, pauseCycle = true) {
    const now = Date.now();
    this.advancePomodoro(now);
    const { active } = this.store.state;
    if (!active) return;

    const task = this.store.findTask(active);
    if (task && !task.end) {
      const stoppedAt = new Date(now).toISOString();
      if (!task.start) task.start = stoppedAt;
      if (!Number.isFinite(task.accumulatedMs)) task.accumulatedMs = 0;
      task.accumulatedMs += this.elapsed(task.start, now);
      task.end = stoppedAt;
      this.recordTaskSession(task, task.end);
    }
    this.store.state.active = null;
    if (pauseCycle) this.pausePomodoro(now);
    else this.store.save();
    this.checkInActive = false;
    this.totalActiveFocusMs = 0;
    this.lastActiveTick = null;
    this.elements.checkinDisplay.hidden = true;
    this.elements.centerStage.dataset.checkinState = "";
    if (redraw) this.render();
  }

  openCheckIn() {
    this.checkInActive = true;
    this.checkInDeadline = Date.now() + 30000; // 30 seconds
    this.elements.checkinDisplay.hidden = false;
    this.elements.centerStage.dataset.checkinState = "active";
    this.elements.checkinCountdown.textContent = "30";
    this.playPhaseSound("break"); // Plays an alert sound
  }

  confirmCheckIn() {
    this.checkInActive = false;
    this.elements.checkinDisplay.hidden = true;
    this.elements.centerStage.dataset.checkinState = "";
    
    // Reset the timer so it asks again after another 1 hour of focus
    this.totalActiveFocusMs = 0;
    this.lastActiveTick = Date.now(); 
  }

  checkInTimeout() {
    this.checkInActive = false;
    this.elements.checkinDisplay.hidden = true;
    this.elements.centerStage.dataset.checkinState = "";
    this.stopTask(); // Automatically stops and pauses the task
  }

  toggleDone(id) {
    const task = this.store.findTask(id);
    if (!task) return;
    if (task.done) {
      task.done = false;
      task.completedAt = undefined;
      this.store.save();
      this.render();
    } else {
      this.completeTask(task);
    }
  }

  today() {
    return this.dateKey(new Date());
  }

  dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  formatTime(value) {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  formatDateTime(value) {
    if (value === undefined || value === null || value === "") return "Not recorded";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Not recorded";
    return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  formatTaskDate(value) {
    if (!value) return "Not set";
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (!Number.isFinite(date.getTime())) return "Not set";
    return date.toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  }

  elapsed(start, end = Date.now()) {
    if (!start) return 0;
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return 0;
    return Math.max(0, endTime - startTime);
  }

  taskDuration(task, now = Date.now()) {
    if (Number.isFinite(task.accumulatedMs)) {
      const currentSegment = this.store.state.active === task.id && !task.end
        ? this.elapsed(task.start, now)
        : 0;
      return task.accumulatedMs + currentSegment;
    }
    return this.elapsed(task.start, task.end || now);
  }

  duration(milliseconds) {
    const safeMilliseconds = Number.isFinite(milliseconds) ? milliseconds : 0;
    const seconds = Math.floor(safeMilliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
    return `${remainder}s`;
  }

  randomColor() {
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue} 70% 55%)`;
  }

  escape(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));
  }

  // Spreads the date's letters so it is exactly as wide as the clock (or shrinks it if it is wider).
  // Everything is in em, so the result is the same at every stage size and only needs
  // recomputing when the text changes or fonts finish loading (or the panel moves window).
  closeFocusTasks() {
    this.elements.focusTasksDropdown.classList.remove("is-open");
    this.elements.focusTasksToggle.setAttribute("aria-expanded", "false");
  }

  setPipButtonState(isOpen) {
    const button = this.elements.pomodoroPipButton;
    button.setAttribute("aria-pressed", String(isOpen));
    button.setAttribute("aria-label", isOpen ? "Exit picture in picture" : "Enter picture in picture");
  }

  async toggleDocumentPiP() {
    if (!window.documentPictureInPicture) {
      alert("Document Picture-in-Picture is not supported in your browser.");
      return;
    }

    const centerStage = this.elements.centerStage;

    if (window.documentPictureInPicture.window) {
      window.documentPictureInPicture.window.close();
      return;
    }

    try {
      // Wider than tall, like the stage itself (--stage-ratio in page-focus.css).
      // The window is free-form: the stage keeps its ratio and letterboxes inside it,
      // so we never fight the user's resizing.
      const pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 480,
        height: 270
      });
      const pipDocument = pipWindow.document;

      // 1. Copy stylesheets. All PiP layout lives in page-focus.css (body.is-pip).
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
        const newLink = pipDocument.createElement('link');
        newLink.rel = 'stylesheet';
        newLink.href = new URL(link.href, window.location.href).href;
        pipDocument.head.appendChild(newLink);
      });

      document.querySelectorAll('style:not(#clockFontFaces)').forEach(style => {
        const newStyle = pipDocument.createElement('style');
        newStyle.textContent = style.textContent;
        pipDocument.head.appendChild(newStyle);
      });

      // 2. Background image (chosen at runtime, so it can't come from the stylesheet)
      const bgImage = getComputedStyle(document.body).backgroundImage;
      let safeBg = bgImage;
      if (bgImage && bgImage !== 'none') {
        const match = bgImage.match(/url\(["']?(.*?)["']?\)/);
        if (match && match[1]) {
          safeBg = `url("${new URL(match[1], window.location.href).href}")`;
        }
      } else {
        safeBg = `url("${new URL("images/bg.jpg", window.location.href).href}")`;
      }

      pipDocument.body.style.cssText = `
        background-image: ${safeBg};
        background-position: center;
        background-size: cover;
        background-repeat: no-repeat;
        background-attachment: fixed;
      `;

      this.installFontStyles();
      pipDocument.body.classList.add("is-pip");
      pipDocument.body.appendChild(centerStage);
      this.setPipButtonState(true);

      // 3. The page's own click/Escape listeners don't see this window, so the tasks
      //    popout needs its own: Escape or a click outside it closes it.
      const dismissTasks = event => {
        const dropdown = this.elements.focusTasksDropdown;
        if (!dropdown.classList.contains("is-open")) return;
        const dismiss = event.type === "keydown"
          ? event.key === "Escape"
          : !dropdown.contains(event.target);
        if (dismiss) this.closeFocusTasks();
      };
      pipDocument.addEventListener("click", dismissTasks);
      pipDocument.addEventListener("keydown", dismissTasks);

      // 4. When PiP closes, move the clock panel back exactly where it was.
      //    "pagehide" is the reliable close signal ("unload" is being phased out).
      pipWindow.addEventListener("pagehide", () => {
        const focusPage = document.querySelector('.focus-page');
        if (focusPage && centerStage) {
          focusPage.insertBefore(centerStage, focusPage.firstElementChild);
        }
        this.closeFocusTasks();
        this.setPipButtonState(false);
        this.render();
      }, { once: true });

    } catch (err) {
      console.error("Failed to open PiP:", err);
    }
  }
}

new FocusApp(document);
new CloudSync(document);