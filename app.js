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
      pomodoroSettings: { focusMinutes: 25, breakMinutes: 5 }
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
      pomodoroSettings: { ...defaults.pomodoroSettings, ...savedPomodoroSettings }
    };
  }

  save() {
    localStorage.setItem(FocusStore.KEY, JSON.stringify(this.state));
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
  static BACKGROUNDS = ["images/bg.jpg", "images/bg2.jpg", "images/bg3.jpg", "images/bg4.jpg", "images/bg5.jpg"];
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
    this.focusCategory = "all";
    this.lastCalendarMinute = null;
    this.lastFocusTaskDate = this.today();
    this.calendarAutoScrollPending = true;
    this.audioContext = null;
    this.elements = this.getElements();
    this.renderBackgroundChoices();
    this.selectedCategory = "all";
    this.hideCompleted = false;
    const savedBackground = localStorage.getItem("focus-background-image");
    this.setBackgroundImage(FocusApp.BACKGROUNDS.includes(savedBackground) ? savedBackground : FocusApp.BACKGROUNDS[0], false);
    this.bindEvents();
    this.render();
    window.setInterval(() => {
      const phaseChanged = this.advancePomodoro(Date.now());
      if (phaseChanged) {
        this.render();
        return;
      }
      this.renderClock();
      this.renderPomodoro();
      this.renderLiveTimers();
      this.renderFocusSummary();
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
      date: query("#date"),
      clock: query("#clock"),
      liveTime: query("#liveTime"),
      taskPlanner: query("#taskPlanner"),
      taskPlannerMonth: query("#taskPlannerMonth"),
      taskPlannerGrid: query("#taskPlannerGrid"),
      fullscreenButton: query("#fullscreenButton"),
      focusNowWidget: query("#focusNowWidget"),
      focusNowTask: query("#focusNowTask"),
      timeLine: query("#timeLine"),
      focusTasksPanel: query("#focusTasksPanel"),
      backgroundChoices: query("#backgroundChoices"),
      categoryFilter: query("#categoryFilter"),
      taskSelectedDate: query("#taskSelectedDate"),
      categoryEditor: query("#categoryEditor"),
      tasks: query("#tasks"),
      focusTasks: query("#focusTasks"),
      focusAddTask: query("#focusAddTask"),
      focusTotal: query("#focusTotal"),
      focusProgress: query("#focusProgress"),
      focusBreakdown: query("#focusBreakdown"),
      activityMonths: query("#activityMonths"),
      activityGrid: query("#activityGrid"),
      activityYear: query("#activityYear"),
      activityTrendRange: query("#activityTrendRange"),
      activityTrendChart: query("#activityTrendChart"),
      focusSelectedDate: query("#focusSelectedDate"),
      pomodoroPhase: query("#pomodoroPhase"),
      pomodoroProgress: query("#pomodoroProgress"),
      pomodoroProgressArc: query("#pomodoroProgressArc"),
      pomodoroSettings: query("#pomodoroSettings"),
      pomodoroFocusMinutes: query("#pomodoroFocusMinutes"),
      pomodoroBreakMinutes: query("#pomodoroBreakMinutes"),
      skipBreak: query("#skipBreak"),
      pomodoroReset: query("#pomodoroReset"),
      clockPanel: query("#clockPanel"),
      pomodoroDisplay: query("#pomodoroDisplay"),
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
      focusCategoryFilter: query("#focusCategoryFilter"),

      settingsButton: query("#settingsButton"),
      settingsPanel: query("#settingsPanel"),
      settingsBackdrop: query("#settingsBackdrop"),
      closeSettings: query("#closeSettings"),
    };
  }

  bindEvents() {
    this.document.addEventListener("pointerdown", () => this.unlockAudio(), { once: true });
    this.document.addEventListener("fullscreenchange", () => this.updateFullscreenButtonState());
    this.document.addEventListener("webkitfullscreenchange", () => this.updateFullscreenButtonState());

    this.document.querySelector("#addTask").onclick = () => this.openNewTaskModal();
    this.elements.focusAddTask.onclick = () => this.openNewTaskModal();

    this.document.querySelector("#addCat").onclick = () => this.addCategory();
    this.elements.fullscreenButton.onclick = () => this.toggleFullscreen();
    this.elements.backgroundChoices.onclick = event => {
      const choice = event.target.closest("[data-background]");
      if (choice) this.setBackgroundImage(choice.dataset.background);
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
    });

    this.document.addEventListener("click", event => {
      const modal = this.document.getElementById("taskModal");
      
      // If modal is open, close it when clicking the dark backdrop
      if (modal && !modal.hidden) {
        if (event.target === modal) {
          this.closeTaskModal();
        }
      } else {
        // Standard fallback to close any open inline tasks
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








    this.elements.pomodoroSettings.onsubmit = event => {
      event.preventDefault();
      this.savePomodoroSettings();
    };
    this.elements.skipBreak.onclick = () => this.skipBreak();
    this.elements.pomodoroReset.onclick = () => this.resetPomodoro();
    this.document.querySelector("#editCategories").onclick = () => this.toggleCategoryEditor();
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
    this.elements.pomodoroPipButton.onclick = () => this.toggleDocumentPiP();
    this.renderFocusCategoryFilter();
  }

  renderFocusCategoryFilter() {
    const { categories, tasks } = this.store.state;
    const today = this.today();
    const allCount = tasks.filter(task => task.date === today).length;
    const options = [`<option value="all">All categories (${allCount})</option>`];
    categories.forEach(category => {
      const count = tasks.filter(task => task.date === today && task.category === category.id).length;
      options.push(`<option value="${this.escape(category.id)}">${this.escape(category.name)} (${count})</option>`);
    });
    this.elements.focusCategoryFilter.innerHTML = options.join("");
    this.elements.focusCategoryFilter.value = this.focusCategory;
    this.elements.focusCategoryFilter.onchange = event => {
      this.focusCategory = event.target.value;
      this.renderTasks();
    };
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
    this.elements.date.textContent = new Date().toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
    this.renderClock();
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
    this.elements.date.style.visibility = timerRunning ? "hidden" : "visible";
    if (!timerRunning) this.elements.clock.textContent = currentTime;
  }

  renderPomodoro(now = Date.now()) {
    const pomodoro = this.store.state.pomodoro;
    this.elements.pomodoroDisplay.hidden = !pomodoro;
    this.elements.clockPanel.dataset.pomodoroState = !pomodoro
      ? "idle"
      : pomodoro.paused
        ? "paused"
        : "running";
    this.elements.skipBreak.hidden = pomodoro?.phase !== "break";
    this.elements.pomodoroProgressArc.setAttribute("data-phase", pomodoro?.phase || "work");
    let progress = 0;
    if (!pomodoro) {
      this.elements.pomodoroPhase.textContent = "Ready to focus";
    } else {
      const phaseDuration = Number.isFinite(pomodoro.phaseDurationMs)
        ? pomodoro.phaseDurationMs
        : this.phaseDurationMs(pomodoro.phase);
      const remaining = pomodoro.paused && Number.isFinite(pomodoro.remainingMs)
        ? pomodoro.remainingMs
        : pomodoro.phaseEndsAt - now;
      const clampedRemaining = Math.max(0, Math.min(phaseDuration, remaining));
      const elapsed = phaseDuration - clampedRemaining;
      progress = elapsed / phaseDuration;
      this.elements.pomodoroPhase.textContent = `${pomodoro.phase === "break" ? "Break" : "Focus"}${pomodoro.paused ? " paused" : ""}`;
      if (!pomodoro.paused && this.store.state.active) {
        this.elements.clock.textContent = this.formatPomodoroTime(Math.ceil(clampedRemaining / 1000));
      }
    }

    this.elements.pomodoroProgress.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
    this.elements.pomodoroProgressArc.style.strokeDashoffset = String(100 * (1 - progress));
  }

  skipBreak() {
    const pomodoro = this.store.state.pomodoro;
    if (!pomodoro || pomodoro.phase !== "break") return;

    const now = Date.now();
    const activeTask = this.store.state.active
      ? this.store.findTask(this.store.state.active)
      : null;
    const phaseDurationMs = this.focusDurationMs();
    pomodoro.phase = "work";
    pomodoro.phaseStartedAt = now;
    pomodoro.phaseDurationMs = phaseDurationMs;
    pomodoro.phaseEndsAt = now + phaseDurationMs;
    if (activeTask) {
      pomodoro.paused = false;
      delete pomodoro.remainingMs;
      this.resumeActiveTask(now);
    } else {
      pomodoro.paused = true;
      pomodoro.remainingMs = phaseDurationMs;
    }

    this.playPhaseSound("work");
    this.store.save();
    this.render();
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
    return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
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

  setBackgroundImage(image, persist = true) {
    if (!FocusApp.BACKGROUNDS.includes(image)) return;
    this.selectedBackgroundImage = image;
    this.document.body.style.backgroundImage = image === "none" ? "none" : `url("${image}")`;
    this.elements.backgroundChoices.querySelectorAll("[data-background]").forEach(choice => {
      const selected = choice.dataset.background === image;
      choice.classList.toggle("selected", selected);
      choice.setAttribute("aria-pressed", String(selected));
    });
    if (persist) localStorage.setItem("focus-background-image", image);
  }


  renderBackgroundChoices() {
    this.elements.backgroundChoices.innerHTML = FocusApp.BACKGROUNDS.map(image =>
      `<button class="background-choice" type="button" data-background="${this.escape(image)}" aria-pressed="false"><img src="${this.escape(image)}" alt=""><span>${this.escape(image)}</span></button>`
    ).join("");
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
    this.elements.categoryEditor.innerHTML = this.store.state.categories.length
      ? this.store.state.categories.map(category => `<div class="category-row" data-category-id="${this.escape(category.id)}">
          <span class="category-row-name"><span class="dot" style="background:${this.escape(category.color)}"></span>${this.escape(category.name)}</span>
          <input class="category-color" type="color" value="${this.colorPickerValue(category.color)}" aria-label="Change ${this.escape(category.name)} color">
          <button class="remove-category" type="button" data-action="remove-category" title="Remove ${this.escape(category.name)}" aria-label="Remove ${this.escape(category.name)}">×</button>
        </div>`).join("")
      : '<div class="category-editor-empty">No categories yet.</div>';

    this.elements.categoryEditor.querySelectorAll(".category-row").forEach(row => {
      const categoryId = row.dataset.categoryId;
      row.querySelector(".category-color").oninput = event => this.changeCategoryColor(categoryId, event.target.value);
      row.querySelector('[data-action="remove-category"]').onclick = () => this.removeCategory(categoryId);
    });
  }

  toggleCategoryEditor() {
    this.elements.categoryEditor.hidden = !this.elements.categoryEditor.hidden;
    if (!this.elements.categoryEditor.hidden) this.renderCategoryEditor();
  }

  changeCategoryColor(id, color) {
    const category = this.store.state.categories.find(item => item.id === id);
    if (!category) return;
    category.color = color;
    this.store.save();
    this.renderTasks();
    const row = this.elements.categoryEditor.querySelector(`[data-category-id="${this.escape(id)}"] .dot`);
    if (row) row.style.background = color;
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
      .filter(task => this.focusCategory === "all" || task.category === this.focusCategory)
      .sort((first, second) => (first.created || 0) - (second.created || 0));

    this.renderTaskList(this.elements.tasks, tasks);
    this.renderTaskList(this.elements.focusTasks, todaysTasks);
    const activeTask = this.store.state.active
      ? this.store.findTask(this.store.state.active)
      : null;
    this.elements.focusNowWidget.hidden = !activeTask;
    this.elements.focusNowTask.innerHTML = activeTask ? this.taskMarkup(activeTask, true) : "";
    this.bindTaskEvents(this.elements.tasks);
    this.bindTaskEvents(this.elements.focusTasks);
    this.bindTaskEvents(this.elements.focusNowTask);
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
    [this.elements.tasks, this.elements.focusTasks, this.elements.focusNowTask].forEach(container => {
      container.querySelectorAll(".task[data-task-id]").forEach(taskElement => {
        const task = this.store.findTask(taskElement.dataset.taskId);
        const timer = taskElement.querySelector(".timer");
        if (!task || !timer) return;

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
    const events = [];

    this.store.state.tasks.forEach(task => {
      const sessions = this.taskSessions(task, now);

      const category = this.store.state.categories.find(item => item.id === task.category);
      sessions.forEach(session => {
        const start = new Date(session.start).getTime();
        const end = new Date(session.end).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        const clippedStart = Math.max(start, dayStart);
        const clippedEnd = Math.min(end, dayEnd);
        if (clippedEnd <= clippedStart) return;

        const top = ((clippedStart - dayStart) / dayLength) * 100;
        const height = ((clippedEnd - clippedStart) / dayLength) * 100;
        const startLabel = this.formatTime(clippedStart);
        const endLabel = this.formatTime(clippedEnd);
        const categoryColor = category?.color || "#999";
        events.push(`<div class="timeline-event" style="--event-color:${this.escape(categoryColor)};border-left:4px solid ${this.escape(categoryColor)};--event-top:${top}%;--event-height:${height}%" title="${this.escape(task.name)} · ${startLabel}–${endLabel}">${this.escape(task.name)}</div>`);
      });
    });

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
    this.elements.focusProgress.innerHTML = targetMilliseconds
      ? `<div class="focus-goal-label"><span>Daily target</span><span>${this.duration(targetMilliseconds)}</span></div><div class="focus-goal-track" role="progressbar" aria-label="Daily focus target progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><div class="focus-goal-bar" style="width:${progress}%"></div></div>`
      : '<div class="focus-goal-empty">No focus target set for this day.</div>';
    this.elements.focusBreakdown.innerHTML = totals.length
      ? totals.map(category => {
        const percentage = totalMilliseconds ? (category.milliseconds / totalMilliseconds) * 100 : 0;
        return `<div class="focus-row">
          <div class="focus-row-head"><span><span class="dot" style="background:${this.escape(category.color)}"></span>${this.escape(category.name)}</span><span>${this.duration(category.milliseconds)}</span></div>
          <div class="focus-track"><div class="focus-bar" style="width:${percentage}%;background:${this.escape(category.color)}"></div></div>
        </div>`;
      }).join("")
      : '<div class="focus-empty">No categories yet.</div>';
  }

  renderActivityCalendar(now = Date.now()) {
    const currentYear = new Date(now).getFullYear();
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

    const rangeEnd = yearEnd.getTime();
    this.store.state.tasks.forEach(task => {
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
      if (milliseconds < 15 * 60 * 1000) return 1;
      if (milliseconds < 60 * 60 * 1000) return 2;
      if (milliseconds < 2 * 60 * 60 * 1000) return 3;
      return 4;
    };
    this.elements.activityGrid.innerHTML = dateKeys.map(date => {
      if (!date) return '<span class="activity-cell activity-padding" aria-hidden="true"></span>';
      const milliseconds = totals.get(date);
      const level = levelFor(milliseconds);
      return `<button class="activity-cell" type="button" data-activity-date="${date}" data-level="${level}" aria-label="${this.escape(this.formatTaskDate(date))}: ${this.escape(this.duration(milliseconds))} focus time" aria-pressed="${date === this.selectedDate}" title="${this.escape(this.formatTaskDate(date))}: ${this.escape(this.duration(milliseconds))}"></button>`;
    }).join("");

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
        const start = new Date(year, month, day);
        const end = new Date(year, month, day + 1);
        buckets.push({ start, end, label: String(day) });
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

    const points = buckets.map(bucket => ({
      ...bucket,
      milliseconds: this.focusDurationBetween(bucket.start.getTime(), bucket.end.getTime(), now)
    }));
    const activePoints = points.filter(point => point.milliseconds > 0).length;
    if (activePoints < 2) {
      this.elements.activityTrendChart.innerHTML = '<p class="focus-trend-empty">Not enough data</p>';
      return;
    }

    const width = 640;
    const height = 210;
    const left = 48;
    const right = 14;
    const top = 14;
    const bottom = 35;
    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;
    const maxValue = Math.max(...points.map(point => point.milliseconds));
    const yMax = Math.ceil(maxValue / (60 * 60 * 1000)) * 60 * 60 * 1000 || maxValue;
    const coordinates = points.map((point, index) => ({
      ...point,
      x: left + (index / Math.max(1, points.length - 1)) * chartWidth,
      y: top + chartHeight - (point.milliseconds / yMax) * chartHeight
    }));
    const line = coordinates.map(point => `${point.x},${point.y}`).join(" ");
    const labelIndexes = new Set([
      0,
      Math.round((points.length - 1) / 4),
      Math.round((points.length - 1) / 2),
      Math.round((points.length - 1) * 3 / 4),
      points.length - 1
    ]);
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
        ? `${this.formatTaskDate(this.dateKey(points[0].start))} – ${this.formatTaskDate(this.dateKey(points[points.length - 1].start))}`
        : this.selectedActivityRange === "monthly"
          ? anchorDate.toLocaleDateString([], { month: "long", year: "numeric" })
          : String(selectedYear);
    const axis = yTicks.map(value => {
      const y = top + chartHeight - (value / yMax) * chartHeight;
      return `<g class="trend-y-tick"><line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line><text x="${left - 8}" y="${y + 4}" text-anchor="end">${formatAxisDuration(value)}</text></g>`;
    }).join("");
    const xLabels = coordinates.map((point, index) => labelIndexes.has(index)
      ? `<text class="trend-x-label" x="${point.x}" y="${height - 12}" text-anchor="middle">${this.escape(point.label)}</text>`
      : "").join("");
    const circles = coordinates.map(point =>
      `<circle class="trend-point" cx="${point.x}" cy="${point.y}" r="3"><title>${this.escape(point.label)}: ${this.escape(this.duration(point.milliseconds))}</title></circle>`
    ).join("");

    this.elements.activityTrendChart.innerHTML = `<div class="focus-trend-caption">${rangeLabel} focus time · ${this.escape(periodCaption)}</div><svg class="focus-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${rangeLabel} focus time trend">
      ${axis}<polyline class="trend-line" points="${line}"></polyline>${circles}${xLabels}
    </svg>`;
  }

  focusDurationBetween(startTime, endTime, now = Date.now()) {
    const clippedEnd = Math.min(endTime, now);
    if (clippedEnd <= startTime) return 0;
    return this.store.state.tasks.reduce((total, task) => total + this.taskSessions(task, now).reduce((taskTotal, session) => {
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
          ${timer}<div class="task-actions">${sessionButton}</div>
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
        <input class="task-detail-name" type="text" value="${this.escape(task.name)}" aria-label="Task name" autocomplete="off" placeholder="What needs your focus?">
        ${isNew ? '' : `<button class="task-detail-delete" type="button" data-action="delete" aria-label="Delete task" title="Delete task">
          <img src="icons/trash.svg" alt="">
        </button>`}
      </div>
      <div class="task-detail-fields">
        <label class="task-detail-field">
          <span>Planned date</span>
          <input type="date" class="task-detail-date" value="${this.escape(task.date || "")}">
        </label>
        <label class="task-detail-field">
          <span>Category</span>
          <select class="task-detail-category">${categoryOptions}</select>
        </label>
        <label class="task-detail-field">
          <span>Priority</span>
          <select class="task-detail-priority">
            <option value="high"${priority === "high" ? " selected" : ""}>High priority</option>
            <option value="medium"${priority === "medium" ? " selected" : ""}>Medium priority</option>
            <option value="low"${priority === "low" ? " selected" : ""}>Low priority</option>
          </select>
        </label>
      </div>
      
      ${isNew ? '' : `
      <details class="task-detail-sessions">
        <summary>
          <span>Focus sessions</span>
          <span class="task-detail-sessions-total">${this.duration(this.taskDuration(task))}</span>
        </summary>
        <dl class="task-properties">
          <div><dt>Created</dt><dd>${this.escape(this.formatDateTime(task.created))}</dd></div>
          <div><dt>Completed at</dt><dd>${this.escape(completionTime)}</dd></div>
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
            done: false
          });
        } else {
          // Update existing task
          task.name = newName;
          if (this.isDateKey(newDate)) task.date = newDate;
          task.category = newCategory;
          task.priority = newPriority;
          
          const isDone = details.querySelector('[data-action="toggle-draft"]').classList.contains("is-done");
          if (task.done !== isDone) {
            task.done = isDone;
            task.completedAt = task.done ? new Date().toISOString() : undefined;
          }
          this.store.save();
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
    const promptFn = typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt.bind(window) : null;
    const name = promptFn ? promptFn("Category name:") : null;
    if (!name?.trim()) return;

    const cleanName = name.trim();
    const id = `${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const color = this.randomColor();
    this.store.addCategory({ id, name: cleanName, color });
    this.selectedCategory = id;
    this.render();
  }

  startTask(id) {
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
    if (redraw) this.render();
  }

  toggleDone(id) {
    const task = this.store.findTask(id);
    if (!task) return;
    task.done = !task.done;
    task.completedAt = task.done ? new Date().toISOString() : undefined;
    this.store.save();
    this.render();
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

  async toggleDocumentPiP() {
    if (!window.documentPictureInPicture) {
      alert("Document Picture-in-Picture is not supported in your browser.");
      return;
    }

    const clockPanel = this.elements.clockPanel;

    if (window.documentPictureInPicture.window) {
      window.documentPictureInPicture.window.close();
      return;
    }

    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 360,
      height: 360
    });

    // Copy all stylesheets over
    [...document.styleSheets].forEach(styleSheet => {
      try {
        const cssRules = [...styleSheet.cssRules].map(rule => rule.cssText).join('');
        const style = pipWindow.document.createElement('style');
        style.textContent = cssRules;
        pipWindow.document.head.appendChild(style);
      } catch {
        const link = pipWindow.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = styleSheet.href;
        pipWindow.document.head.appendChild(link);
      }
    });

    const currentBgImage = document.body.style.backgroundImage || `url("images/bg.jpg")`;

    pipWindow.document.body.style.cssText = `
      margin: 0; 
      display: flex; 
      align-items: center; 
      justify-content: center; 
      background-image: ${currentBgImage}; 
      background-position: center; 
      background-size: cover; 
      background-repeat: no-repeat; 
      background-attachment: fixed;
      height: 100vh; 
      overflow: hidden;
    `;

    pipWindow.document.body.classList.add("is-pip");
    pipWindow.document.body.appendChild(clockPanel);

    pipWindow.addEventListener("unload", () => {
      const focusPage = document.querySelector('.focus-page');
      if (focusPage && clockPanel) {
        focusPage.prepend(clockPanel);
        this.render();
      }
    }, { once: true });
  }
}

new FocusApp(document);