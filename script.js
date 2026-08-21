(() => {
  "use strict";

  // 1. Константы и схема начального состояния
  const STORAGE_KEY = "myWeeklyPlanner";
  const STORAGE_SCHEMA_VERSION = 1;
  const WRITE_LOCK_NAME = "myWeeklyPlanner-write";
  const CATEGORY_IDS = ["work", "personal", "home", "study"];
  const CATEGORIES = {
    work: { label: "Работа" },
    personal: { label: "Личное" },
    home: { label: "Дом" },
    study: { label: "Учёба" },
  };
  const TASK_TITLE_LIMIT = 200;
  const TASK_NOTE_LIMIT = 2000;
  const DAY_NOTE_LIMIT = 5000;
  const WEEK_GOAL_LIMIT = 300;
  const UNDO_DURATION = 10_000;

  const tabId = createId("tab");
  let appState;
  let visibleWeekStart;
  let selectedDate;
  let inboxWasOpenedBy = null;
  let pointerDrag = null;
  let undoDeletion = null;
  let undoTimerId = null;
  let dayNoteTimerId = null;
  let pendingConfirmation = null;
  let editingMainTaskId = null;
  let suppressInlineRenameBlur = false;
  const dialogReturnFocus = new WeakMap();

  const elements = {};

  function createInitialState() {
    return {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      revision: 0,
      updatedAt: new Date().toISOString(),
      lastWriterId: tabId,
      tasks: [],
      dayNotes: {},
      weekGoals: {},
      weekMainTasks: {},
      carryoverLog: {},
      settings: {
        showCompleted: true,
        showMotivation: true,
        enabledCategoryIds: [...CATEGORY_IDS],
      },
    };
  }

  // 2. Утилиты локальных дат и недель
  function padNumber(value) {
    return String(value).padStart(2, "0");
  }

  function toLocalDateKey(date) {
    return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
  }

  function parseLocalDate(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    if (!match) {
      return null;
    }

    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    if (
      date.getFullYear() !== Number(match[1])
      || date.getMonth() !== Number(match[2]) - 1
      || date.getDate() !== Number(match[3])
    ) {
      return null;
    }

    return date;
  }

  function addDays(date, amount) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12);
    return result;
  }

  function getWeekStart(date) {
    const weekday = date.getDay();
    const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
    return addDays(date, -daysFromMonday);
  }

  function getWeekDates(weekStart) {
    return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  }

  function capitalize(value) {
    return value ? value.charAt(0).toLocaleUpperCase("ru-RU") + value.slice(1) : value;
  }

  function formatWeekRange(weekStart) {
    const weekEnd = addDays(weekStart, 6);
    const dayMonthFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
    const fullDateFormatter = new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const sameMonth = weekStart.getMonth() === weekEnd.getMonth()
      && weekStart.getFullYear() === weekEnd.getFullYear();
    const sameYear = weekStart.getFullYear() === weekEnd.getFullYear();

    if (sameMonth) {
      return `${weekStart.getDate()}–${dayMonthFormatter.format(weekEnd)} ${weekEnd.getFullYear()}`;
    }

    if (sameYear) {
      return `${dayMonthFormatter.format(weekStart)} — ${dayMonthFormatter.format(weekEnd)} ${weekEnd.getFullYear()}`;
    }

    return `${fullDateFormatter.format(weekStart)} — ${fullDateFormatter.format(weekEnd)}`;
  }

  function isSameWeek(firstDate, secondDate) {
    return toLocalDateKey(getWeekStart(firstDate)) === toLocalDateKey(getWeekStart(secondDate));
  }

  // 3. Чтение, проверка и запись хранилища
  function createId(prefix) {
    if (globalThis.crypto?.randomUUID) {
      return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function cloneState(value) {
    if (globalThis.structuredClone) {
      return globalThis.structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeState(candidate) {
    if (!isPlainObject(candidate) || candidate.schemaVersion !== STORAGE_SCHEMA_VERSION) {
      throw new Error("Неподдерживаемая схема данных");
    }

    const settings = isPlainObject(candidate.settings) ? candidate.settings : {};
    const enabledCategoryIds = Array.isArray(settings.enabledCategoryIds)
      ? settings.enabledCategoryIds.filter((id) => CATEGORY_IDS.includes(id))
      : [...CATEGORY_IDS];

    return {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      revision: Number.isInteger(candidate.revision) && candidate.revision >= 0 ? candidate.revision : 0,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
      lastWriterId: typeof candidate.lastWriterId === "string" ? candidate.lastWriterId : null,
      tasks: Array.isArray(candidate.tasks)
        ? candidate.tasks.filter(isPlainObject).map(normalizeTask)
        : [],
      dayNotes: normalizeTextMap(candidate.dayNotes, DAY_NOTE_LIMIT, false),
      weekGoals: normalizeTextMap(candidate.weekGoals, WEEK_GOAL_LIMIT, true),
      weekMainTasks: normalizeWeekMainTasks(candidate.weekMainTasks),
      carryoverLog: isPlainObject(candidate.carryoverLog) ? candidate.carryoverLog : {},
      settings: {
        showCompleted: typeof settings.showCompleted === "boolean" ? settings.showCompleted : true,
        showMotivation: typeof settings.showMotivation === "boolean" ? settings.showMotivation : true,
        enabledCategoryIds,
      },
    };
  }

  function normalizeTextMap(candidate, limit, weekKeysOnly) {
    if (!isPlainObject(candidate)) {
      return {};
    }
    return Object.fromEntries(Object.entries(candidate).filter(([key, value]) => {
      const date = parseLocalDate(key);
      return date && (!weekKeysOnly || toLocalDateKey(getWeekStart(date)) === key)
        && typeof value === "string" && value.trim();
    }).map(([key, value]) => [key, value.slice(0, limit)]));
  }

  function normalizeWeekMainTasks(candidate) {
    if (!isPlainObject(candidate)) {
      return {};
    }
    const result = {};
    Object.entries(candidate).forEach(([weekStart, task]) => {
      const date = parseLocalDate(weekStart);
      if (!date || toLocalDateKey(getWeekStart(date)) !== weekStart || !isPlainObject(task)) {
        return;
      }
      const title = normalizeTaskTitle(task.title);
      if (!title) {
        return;
      }
      const now = new Date().toISOString();
      result[weekStart] = {
        id: typeof task.id === "string" && task.id ? task.id : createId("main"),
        weekStart,
        title,
        isCompleted: Boolean(task.isCompleted),
        createdAt: typeof task.createdAt === "string" ? task.createdAt : now,
        updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : now,
      };
    });
    return result;
  }

  function normalizeTask(task, index) {
    const now = new Date().toISOString();
    const normalizedDate = task.date === null
      ? null
      : typeof task.date === "string" && parseLocalDate(task.date) ? task.date : null;
    return {
      id: typeof task.id === "string" && task.id ? task.id : createId("task"),
      title: typeof task.title === "string"
        ? task.title.trim().slice(0, TASK_TITLE_LIMIT) || "Задача без названия"
        : "Задача без названия",
      note: typeof task.note === "string" ? task.note.slice(0, TASK_NOTE_LIMIT) : "",
      categoryId: CATEGORY_IDS.includes(task.categoryId) ? task.categoryId : null,
      isImportant: Boolean(task.isImportant),
      isCompleted: Boolean(task.isCompleted),
      completedAt: typeof task.completedAt === "string" ? task.completedAt : null,
      date: normalizedDate,
      order: Number.isFinite(task.order) ? task.order : index,
      createdAt: typeof task.createdAt === "string" ? task.createdAt : now,
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : now,
      sourceTaskId: typeof task.sourceTaskId === "string" ? task.sourceTaskId : null,
      carryoverKey: typeof task.carryoverKey === "string" ? task.carryoverKey : null,
    };
  }

  function parseStoredState(rawValue) {
    return normalizeState(JSON.parse(rawValue));
  }

  function readRawState() {
    return globalThis.localStorage.getItem(STORAGE_KEY);
  }

  function writeRawState(state) {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function backUpInvalidState(rawValue) {
    if (rawValue === null) {
      return;
    }

    const timestamp = new Date().toISOString();
    globalThis.localStorage.setItem(`${STORAGE_KEY}_corrupted_${timestamp}`, rawValue);
  }

  function recoverFromInvalidState(rawValue) {
    try {
      backUpInvalidState(rawValue);
    } catch (error) {
      console.error("Не удалось сохранить повреждённые данные", error);
    }

    const initialState = createInitialState();
    try {
      writeRawState(initialState);
    } catch (error) {
      console.error("Не удалось создать чистое состояние", error);
    }
    return initialState;
  }

  function loadInitialState() {
    let rawValue;
    try {
      rawValue = readRawState();
    } catch (error) {
      console.error("Хранилище браузера недоступно", error);
      return { state: createInitialState(), recovered: false, storageError: true };
    }

    if (rawValue === null) {
      const initialState = createInitialState();
      try {
        writeRawState(initialState);
        return { state: initialState, recovered: false, storageError: false };
      } catch (error) {
        console.error("Не удалось сохранить начальное состояние", error);
        return { state: initialState, recovered: false, storageError: true };
      }
    }

    try {
      return { state: parseStoredState(rawValue), recovered: false, storageError: false };
    } catch (error) {
      console.error("Ошибка чтения состояния планировщика", error);
      return { state: recoverFromInvalidState(rawValue), recovered: true, storageError: false };
    }
  }

  function readLatestState() {
    const rawValue = readRawState();
    if (rawValue === null) {
      return createInitialState();
    }
    return parseStoredState(rawValue);
  }

  async function commitOperation(operation) {
    const write = () => {
      let latestState;
      let storageReadFailed = false;
      try {
        latestState = readLatestState();
      } catch (error) {
        console.error("Не удалось прочитать свежие данные перед записью", error);
        latestState = cloneState(appState);
        storageReadFailed = true;
      }

      const nextState = cloneState(latestState);
      const operationApplied = operation(nextState);
      if (operationApplied === false) {
        return false;
      }

      nextState.revision = latestState.revision + 1;
      nextState.updatedAt = new Date().toISOString();
      nextState.lastWriterId = tabId;

      try {
        writeRawState(nextState);
        appState = nextState;
        renderAll();
        if (storageReadFailed) {
          showToast("Изменения сохранены, но перед записью не удалось прочитать хранилище.", 8000);
        }
        return true;
      } catch (error) {
        console.error("Не удалось сохранить данные", error);
        appState = nextState;
        renderAll();
        showToast("Изменения видны сейчас, но могут потеряться после перезагрузки.", 8000);
        return true;
      }
    };

    if (globalThis.navigator?.locks?.request) {
      return globalThis.navigator.locks.request(WRITE_LOCK_NAME, write);
    }

    return write();
  }

  function shouldAcceptIncomingState(incomingState) {
    if (incomingState.revision > appState.revision) {
      return true;
    }

    if (incomingState.revision < appState.revision) {
      return false;
    }

    return Date.parse(incomingState.updatedAt) > Date.parse(appState.updatedAt);
  }

  function handleExternalStorageChange(event) {
    if (event.storageArea !== globalThis.localStorage || event.key !== STORAGE_KEY) {
      return;
    }

    if (event.newValue === null) {
      appState = createInitialState();
      resetInterfaceToToday();
      document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
      renderAll();
      showToast("Данные удалены в другой вкладке.");
      return;
    }

    try {
      const incomingState = parseStoredState(event.newValue);
      if (incomingState.lastWriterId === tabId || !shouldAcceptIncomingState(incomingState)) {
        return;
      }

      const inlineRenameDraft = captureInlineRenameDraft();
      suppressInlineRenameBlur = true;
      try {
        appState = incomingState;
        renderAll();
        closeEditorsForMissingTasks();
        restoreInlineRenameDraft(inlineRenameDraft);
      } finally {
        suppressInlineRenameBlur = false;
      }
      showToast("Данные изменились в другой вкладке.");
    } catch (error) {
      console.error("Получены некорректные данные из другой вкладки", error);
      showToast("Не удалось применить изменение из другой вкладки.");
    }
  }

  // 4. Операции над состоянием
  function isSameTaskList(firstDate, secondDate) {
    return firstDate === secondDate;
  }

  function getSortedTasks(tasks) {
    return [...tasks].sort((first, second) => {
      if (first.isCompleted !== second.isCompleted) {
        return first.isCompleted ? 1 : -1;
      }
      if (first.order !== second.order) {
        return first.order - second.order;
      }
      return String(first.createdAt).localeCompare(String(second.createdAt));
    });
  }

  function reindexTaskList(state, date) {
    getSortedTasks(state.tasks.filter((task) => isSameTaskList(task.date, date)))
      .forEach((task, index) => {
        task.order = index;
      });
  }

  function getNextTaskOrder(state, date) {
    const list = state.tasks.filter((task) => isSameTaskList(task.date, date));
    return list.length ? Math.max(...list.map((task) => Number(task.order) || 0)) + 1 : 0;
  }

  function normalizeTaskTitle(value) {
    return String(value ?? "").trim().slice(0, TASK_TITLE_LIMIT);
  }

  async function createTask(title, date) {
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) {
      return false;
    }

    return commitOperation((state) => {
      const now = new Date().toISOString();
      state.tasks.push({
        id: createId("task"),
        title: normalizedTitle,
        note: "",
        categoryId: null,
        isImportant: false,
        isCompleted: false,
        completedAt: null,
        date,
        order: getNextTaskOrder(state, date),
        createdAt: now,
        updatedAt: now,
        sourceTaskId: null,
        carryoverKey: null,
      });
    });
  }

  async function updateTask(taskId, updates) {
    return commitOperation((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) {
        showToast("Задача уже удалена в другой вкладке.");
        return false;
      }

      if (Object.hasOwn(updates, "title")) {
        const title = normalizeTaskTitle(updates.title);
        if (!title) {
          return false;
        }
        task.title = title;
      }
      if (Object.hasOwn(updates, "note")) {
        task.note = String(updates.note ?? "").slice(0, TASK_NOTE_LIMIT);
      }
      if (Object.hasOwn(updates, "categoryId")) {
        task.categoryId = CATEGORY_IDS.includes(updates.categoryId) ? updates.categoryId : null;
      }
      if (Object.hasOwn(updates, "isImportant")) {
        task.isImportant = Boolean(updates.isImportant);
      }
      task.updatedAt = new Date().toISOString();
    });
  }

  async function toggleTaskCompletion(taskId) {
    return commitOperation((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) {
        return false;
      }
      task.isCompleted = !task.isCompleted;
      task.completedAt = task.isCompleted ? new Date().toISOString() : null;
      task.updatedAt = new Date().toISOString();
      task.order = getNextTaskOrder(state, task.date);
      reindexTaskList(state, task.date);
    });
  }

  function moveTaskInState(state, taskId, targetDate, beforeTaskId = null) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
      return false;
    }

    const sourceDate = task.date;
    task.date = targetDate;
    task.updatedAt = new Date().toISOString();

    const targetTasks = getSortedTasks(
      state.tasks.filter((item) => item.id !== taskId && isSameTaskList(item.date, targetDate)),
    );
    let insertIndex = targetTasks.length;
    const beforeTask = targetTasks.find((item) => item.id === beforeTaskId);

    if (beforeTask && beforeTask.isCompleted === task.isCompleted) {
      insertIndex = targetTasks.indexOf(beforeTask);
    } else if (!task.isCompleted) {
      const firstCompletedIndex = targetTasks.findIndex((item) => item.isCompleted);
      insertIndex = firstCompletedIndex === -1 ? targetTasks.length : firstCompletedIndex;
    }

    targetTasks.splice(insertIndex, 0, task);
    targetTasks.forEach((item, index) => {
      item.order = index;
    });

    if (!isSameTaskList(sourceDate, targetDate)) {
      reindexTaskList(state, sourceDate);
    }
    return true;
  }

  async function moveTask(taskId, targetDate, beforeTaskId = null) {
    return commitOperation((state) => moveTaskInState(state, taskId, targetDate, beforeTaskId));
  }

  async function deleteTask(taskId) {
    let deletedSnapshot = null;
    const deleted = await commitOperation((state) => {
      const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
      if (taskIndex === -1) {
        return false;
      }
      deletedSnapshot = {
        type: "task",
        task: cloneState(state.tasks[taskIndex]),
        originalOrder: state.tasks[taskIndex].order,
      };
      const [removedTask] = state.tasks.splice(taskIndex, 1);
      reindexTaskList(state, removedTask.date);
    });

    if (deleted && deletedSnapshot) {
      registerUndoDeletion(deletedSnapshot);
    }
    return deleted;
  }

  async function restoreLastDeletedTask() {
    if (!undoDeletion || Date.now() >= undoDeletion.expiresAt) {
      clearUndoDeletion();
      return false;
    }

    const snapshot = cloneState(undoDeletion.snapshot);
    clearUndoDeletion();
    return commitOperation((state) => {
      if (snapshot.type === "task") {
        if (state.tasks.some((task) => task.id === snapshot.task.id)) {
          return false;
        }
        snapshot.task.order = snapshot.originalOrder;
        state.tasks.push(snapshot.task);
        reindexTaskList(state, snapshot.task.date);
        return true;
      }
      if (snapshot.type === "main-task") {
        if (state.weekMainTasks[snapshot.weekStart]) {
          return false;
        }
        state.weekMainTasks[snapshot.weekStart] = snapshot.task;
        return true;
      }
      return false;
    });
  }

  async function copyTask(taskId, targetDate) {
    let copyId = null;
    const copied = await commitOperation((state) => {
      const source = state.tasks.find((task) => task.id === taskId);
      if (!source) {
        return false;
      }
      const now = new Date().toISOString();
      copyId = createId("task");
      state.tasks.push({
        ...cloneState(source),
        id: copyId,
        isCompleted: false,
        completedAt: null,
        date: targetDate,
        order: getNextTaskOrder(state, targetDate),
        createdAt: now,
        updatedAt: now,
        sourceTaskId: source.id,
        carryoverKey: null,
      });
    });
    return copied ? copyId : null;
  }

  async function saveDayNote(dateKey, value) {
    const note = String(value ?? "").slice(0, DAY_NOTE_LIMIT);
    return commitOperation((state) => {
      if (note.trim()) {
        state.dayNotes[dateKey] = note;
      } else {
        delete state.dayNotes[dateKey];
      }
    });
  }

  async function saveWeekGoal(weekStartKey, value) {
    const goal = String(value ?? "").slice(0, WEEK_GOAL_LIMIT);
    return commitOperation((state) => {
      if (goal.trim()) {
        state.weekGoals[weekStartKey] = goal;
      } else {
        delete state.weekGoals[weekStartKey];
      }
    });
  }

  async function updateSettings(updates) {
    return commitOperation((state) => {
      if (Object.hasOwn(updates, "showCompleted")) {
        state.settings.showCompleted = Boolean(updates.showCompleted);
      }
      if (Object.hasOwn(updates, "showMotivation")) {
        state.settings.showMotivation = Boolean(updates.showMotivation);
      }
      if (Object.hasOwn(updates, "enabledCategoryIds")) {
        state.settings.enabledCategoryIds = CATEGORY_IDS.filter((id) => updates.enabledCategoryIds.includes(id));
      }
    });
  }

  function resetInterfaceToToday() {
    const today = new Date();
    visibleWeekStart = getWeekStart(today);
    selectedDate = toLocalDateKey(today);
    closeInbox();
    clearPointerDrag();
    clearUndoDeletion();
  }

  function deleteAllData() {
    let storageDeleted = true;
    try {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      storageDeleted = false;
      console.error("Не удалось удалить данные из хранилища", error);
    }

    appState = createInitialState();
    resetInterfaceToToday();
    renderAll();
    showToast(
      storageDeleted
        ? "Все данные удалены."
        : "План очищен на экране, но удалить данные из хранилища не удалось.",
      8000,
    );
  }

  async function saveMainWeekTask(weekStartKey, title) {
    const normalizedTitle = normalizeTaskTitle(title);
    if (!normalizedTitle) {
      return false;
    }
    return commitOperation((state) => {
      const existing = state.weekMainTasks[weekStartKey];
      const now = new Date().toISOString();
      state.weekMainTasks[weekStartKey] = existing
        ? { ...existing, title: normalizedTitle, updatedAt: now }
        : {
          id: createId("main"),
          weekStart: weekStartKey,
          title: normalizedTitle,
          isCompleted: false,
          createdAt: now,
          updatedAt: now,
        };
    });
  }

  async function toggleMainWeekTask(weekStartKey) {
    return commitOperation((state) => {
      const task = state.weekMainTasks[weekStartKey];
      if (!task) {
        return false;
      }
      task.isCompleted = !task.isCompleted;
      task.updatedAt = new Date().toISOString();
    });
  }

  async function deleteMainWeekTask(weekStartKey) {
    let deletedSnapshot = null;
    const deleted = await commitOperation((state) => {
      const task = state.weekMainTasks[weekStartKey];
      if (!task) {
        return false;
      }
      deletedSnapshot = { type: "main-task", weekStart: weekStartKey, task: cloneState(task) };
      delete state.weekMainTasks[weekStartKey];
    });
    if (deleted && deletedSnapshot) {
      registerUndoDeletion(deletedSnapshot);
    }
    return deleted;
  }

  async function copyMainWeekTask(sourceWeekStart, targetWeekStart) {
    return commitOperation((state) => {
      const source = state.weekMainTasks[sourceWeekStart];
      if (!source) {
        return false;
      }
      const now = new Date().toISOString();
      state.weekMainTasks[targetWeekStart] = {
        id: createId("main"),
        weekStart: targetWeekStart,
        title: source.title,
        isCompleted: false,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  async function ensureCurrentWeekCarryover() {
    const currentWeekStart = getWeekStart(new Date());
    const currentKey = toLocalDateKey(currentWeekStart);
    const previousWeekStart = addDays(currentWeekStart, -7);
    const previousKey = toLocalDateKey(previousWeekStart);
    const previousDates = new Set(getWeekDates(previousWeekStart).map(toLocalDateKey));
    const logKey = currentKey;
    let copiedCount = 0;

    await commitOperation((state) => {
      if (state.carryoverLog[logKey]) {
        return false;
      }
      const sources = state.tasks.filter((task) => previousDates.has(task.date) && !task.isCompleted);
      const now = new Date().toISOString();
      const copiedTaskIds = [];
      sources.forEach((source) => {
        const carryoverKey = `${source.id}->${currentKey}`;
        if (state.tasks.some((task) => task.carryoverKey === carryoverKey)) {
          return;
        }
        const id = createId("task");
        state.tasks.push({
          ...cloneState(source),
          id,
          isCompleted: false,
          completedAt: null,
          date: currentKey,
          order: getNextTaskOrder(state, currentKey),
          createdAt: now,
          updatedAt: now,
          sourceTaskId: source.id,
          carryoverKey,
        });
        copiedTaskIds.push(id);
      });
      copiedCount = copiedTaskIds.length;
      state.carryoverLog[logKey] = {
        sourceWeekStart: previousKey,
        targetWeekStart: currentKey,
        processedAt: now,
        copiedTaskIds,
      };
    });

    if (copiedCount > 0) {
      const message = copiedCount === 1
        ? "1 незавершённая задача добавлена на понедельник"
        : copiedCount >= 2 && copiedCount <= 4
          ? `${copiedCount} незавершённые задачи добавлены на понедельник`
          : `На понедельник добавлено ${copiedCount} незавершённых задач`;
      showToast(message, 8000);
    }
    return copiedCount;
  }

  // 5. Вычисляемые выборки и счётчики
  function getTasksForDate(dateKey) {
    return getSortedTasks(appState.tasks.filter((task) => task.date === dateKey));
  }

  function getActiveInboxCount() {
    return appState.tasks.filter((task) => task.date === null && !task.isCompleted).length;
  }

  function getProgress(tasks) {
    return {
      completed: tasks.filter((task) => task.isCompleted).length,
      total: tasks.length,
    };
  }

  function getWeekTasks(weekStart) {
    const dateKeys = new Set(getWeekDates(weekStart).map(toLocalDateKey));
    return appState.tasks.filter((task) => dateKeys.has(task.date));
  }

  function getWeekMotivation(progress) {
    if (progress.total === 0) {
      return "Добавьте задачу — прогресс появится здесь.";
    }
    if (progress.completed === 0) {
      return progress.total === 1
        ? "Осталась 1 задача."
        : `В плане ${progress.total} задач — начните с любой.`;
    }

    const ratio = progress.completed / progress.total;
    if (ratio < 0.5) {
      return `Выполнено ${progress.completed} из ${progress.total} — хорошее начало.`;
    }
    if (ratio < 1) {
      const remaining = progress.total - progress.completed;
      return remaining === 1 ? "Осталась 1 задача." : `Осталось задач: ${remaining}.`;
    }
    return "Все задачи недели выполнены.";
  }

  function getDayMotivation(progress) {
    if (progress.total === 0) {
      return "Добавьте первую задачу на этот день.";
    }
    if (progress.completed === 0) {
      return progress.total === 1
        ? "Начните с этой задачи."
        : `В списке ${progress.total} задач — начните с любой.`;
    }
    const ratio = progress.completed / progress.total;
    if (ratio < 0.5) {
      const remaining = progress.total - progress.completed;
      return `Хорошее начало. Осталось задач: ${remaining}.`;
    }
    if (ratio < 1) {
      const remaining = progress.total - progress.completed;
      return remaining === 1
        ? "Большая часть готова. Осталась 1 задача."
        : `Большая часть готова. Осталось задач: ${remaining}.`;
    }
    return "На сегодня всё выполнено.";
  }

  // 6. Отрисовка интерфейса
  function renderHeader() {
    elements.weekPeriod.textContent = formatWeekRange(visibleWeekStart);
    const weekProgress = getProgress(getWeekTasks(visibleWeekStart));
    const progressPercentage = weekProgress.total === 0
      ? 0
      : Math.round((weekProgress.completed / weekProgress.total) * 100);
    elements.weekProgress.textContent = `${weekProgress.completed} из ${weekProgress.total}`;
    elements.weekProgressTrack.setAttribute("aria-valuemax", String(Math.max(weekProgress.total, 1)));
    elements.weekProgressTrack.setAttribute("aria-valuenow", String(weekProgress.completed));
    elements.weekProgressTrack.style.setProperty("--progress-angle", `${progressPercentage * 3.6}deg`);
    elements.weekCompletedCount.textContent = String(weekProgress.completed);
    elements.weekRemainingCount.textContent = String(weekProgress.total - weekProgress.completed);
    elements.weekTotalCount.textContent = String(weekProgress.total);
    elements.weekMotivation.textContent = getWeekMotivation(weekProgress);
    elements.weekMotivation.hidden = !appState.settings.showMotivation;
    elements.inboxCount.textContent = String(getActiveInboxCount());
  }

  function createTaskCard(task) {
    const card = document.createElement("article");
    card.className = "task-card";
    card.dataset.taskId = task.id;
    if (task.isCompleted) {
      card.classList.add("is-completed");
    }
    if (task.isImportant) {
      card.classList.add("is-important");
    }

    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle";
    dragHandle.setAttribute("aria-label", `Перетащить задачу «${task.title}»`);
    dragHandle.title = "Потяните, чтобы перенести задачу";
    dragHandle.textContent = "⠿";

    const completionLabel = document.createElement("label");
    completionLabel.className = "task-checkbox";
    const completionInput = document.createElement("input");
    completionInput.type = "checkbox";
    completionInput.checked = task.isCompleted;
    completionInput.dataset.action = "toggle-task";
    completionInput.setAttribute(
      "aria-label",
      task.isCompleted ? `Вернуть задачу «${task.title}» в активные` : `Выполнить задачу «${task.title}»`,
    );
    completionLabel.append(completionInput);

    const body = document.createElement("div");
    body.className = "task-card-body";
    const title = document.createElement("span");
    title.className = "task-title";
    title.dataset.action = "inline-rename";
    title.tabIndex = 0;
    title.textContent = task.title;
    body.append(title);

    const meta = document.createElement("div");
    meta.className = "task-meta";
    if (task.isImportant) {
      const important = document.createElement("span");
      important.className = "important-marker";
      important.textContent = "Важно";
      meta.append(important);
    }
    if (task.categoryId && CATEGORIES[task.categoryId]) {
      const category = document.createElement("span");
      category.className = `category-chip category-${task.categoryId}`;
      category.textContent = CATEGORIES[task.categoryId].label;
      meta.append(category);
    }
    if (task.note) {
      const noteMarker = document.createElement("span");
      noteMarker.className = "note-marker";
      noteMarker.textContent = "Есть заметка";
      meta.append(noteMarker);
    }
    if (meta.childElementCount) {
      body.append(meta);
    }

    const actions = document.createElement("div");
    actions.className = "task-actions";
    [
      ["edit-task", "Изменить", "✎"],
      ["move-task", "Переместить", "↗"],
      ["delete-task", "Удалить", "×"],
    ].forEach(([action, label, symbol]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-action-button";
      button.dataset.action = action;
      button.setAttribute("aria-label", `${label} задачу «${task.title}»`);
      button.title = label;
      button.textContent = symbol;
      actions.append(button);
    });

    card.append(dragHandle, completionLabel, body, actions);
    return card;
  }

  function renderTaskList(container, tasks, emptyMessage, date) {
    const visibleTasks = appState.settings.showCompleted
      ? tasks
      : tasks.filter((task) => !task.isCompleted);
    container.dataset.listDate = date === null ? "inbox" : date;
    container.replaceChildren();
    if (visibleTasks.length === 0) {
      const emptyState = document.createElement("p");
      emptyState.className = "empty-state";
      emptyState.textContent = tasks.length > 0 && !appState.settings.showCompleted
        ? "Выполненные задачи скрыты настройкой."
        : emptyMessage;
      container.append(emptyState);
      return;
    }
    container.append(...visibleTasks.map(createTaskCard));
  }

  function renderSelectedDay() {
    const date = parseLocalDate(selectedDate);
    if (!date) {
      return;
    }

    const todayKey = toLocalDateKey(new Date());
    const tasks = getTasksForDate(selectedDate);
    const progress = getProgress(tasks);
    const weekdayFormatter = new Intl.DateTimeFormat("ru-RU", { weekday: "long" });
    const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    elements.selectedDayTitle.textContent = capitalize(weekdayFormatter.format(date));
    elements.selectedDayDate.textContent = dateFormatter.format(date);
    elements.selectedDayToday.hidden = selectedDate !== todayKey;
    elements.dayProgress.textContent = `Выполнено ${progress.completed} из ${progress.total}`;
    elements.motivationMessage.textContent = getDayMotivation(progress);
    elements.dayMotivation.hidden = !appState.settings.showMotivation;
    elements.dragInstruction.hidden = tasks.length === 0;
    if (document.activeElement !== elements.dayNote) {
      elements.dayNote.value = typeof appState.dayNotes[selectedDate] === "string"
        ? appState.dayNotes[selectedDate]
        : "";
    }

    renderTaskList(
      elements.selectedDayTasks,
      tasks,
      "На этот день пока ничего не запланировано.",
      selectedDate,
    );
  }

  function renderInbox() {
    renderTaskList(
      elements.inboxTasks,
      getSortedTasks(appState.tasks.filter((task) => task.date === null)),
      "Здесь можно быстро сохранить задачу без даты.",
      null,
    );
  }

  function getOverdueTasks() {
    const today = new Date();
    if (!isSameWeek(visibleWeekStart, today)) {
      return [];
    }
    const todayKey = toLocalDateKey(today);
    const currentWeekDates = new Set(getWeekDates(getWeekStart(today)).map(toLocalDateKey));
    return getSortedTasks(appState.tasks.filter((task) => (
      !task.isCompleted && task.date && task.date < todayKey && currentWeekDates.has(task.date)
    )));
  }

  function createOverdueCard(task) {
    const card = document.createElement("article");
    card.className = "overdue-card";
    card.dataset.taskId = task.id;

    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle overdue-drag-handle";
    dragHandle.setAttribute("aria-label", `Скопировать просроченную задачу «${task.title}» перетаскиванием`);
    dragHandle.title = "Потяните на день текущей недели, чтобы создать копию";
    dragHandle.textContent = "⠿";

    const summary = document.createElement("div");
    summary.className = "overdue-summary";
    const title = document.createElement("strong");
    title.textContent = task.title;
    const date = document.createElement("span");
    date.textContent = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" })
      .format(parseLocalDate(task.date));
    summary.append(title, date);
    if (appState.tasks.some((item) => item.sourceTaskId === task.id)) {
      const copied = document.createElement("span");
      copied.className = "copied-marker";
      copied.textContent = "Копия уже создана";
      summary.append(copied);
    }

    const actions = document.createElement("div");
    actions.className = "overdue-actions";
    [
      ["copy-overdue-today", "На сегодня"],
      ["copy-overdue-other", "Другой день"],
      ["copy-overdue-inbox", "Во Входящие"],
      ["complete-overdue", "Выполнено"],
      ["edit-overdue", "Изменить"],
      ["delete-overdue", "Удалить"],
    ].forEach(([action, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label;
      actions.append(button);
    });
    card.append(dragHandle, summary, actions);
    return card;
  }

  function renderOverdue() {
    const tasks = getOverdueTasks();
    elements.overdueSection.hidden = tasks.length === 0;
    elements.overdueCount.textContent = String(tasks.length);
    if (tasks.length === 0) {
      elements.overdueList.replaceChildren();
      return;
    }
    elements.overdueList.replaceChildren(...tasks.map(createOverdueCard));
  }

  function renderWeekIntentions() {
    const weekStartKey = toLocalDateKey(visibleWeekStart);
    if (document.activeElement !== elements.weekGoal) {
      elements.weekGoal.value = appState.weekGoals[weekStartKey] ?? "";
    }
    const mainTask = appState.weekMainTasks[weekStartKey] ?? null;
    elements.mainWeekTaskContent.replaceChildren();

    const label = document.createElement("p");
    label.className = "section-label";
    label.textContent = "Главное дело недели";
    elements.mainWeekTaskContent.append(label);

    if (!mainTask) {
      const empty = document.createElement("p");
      empty.className = "empty-copy";
      empty.textContent = "Выберите одно главное дело этой недели.";
      elements.mainWeekTaskContent.append(empty);
      elements.selectMainWeekTask.textContent = "Выбрать";
      elements.selectMainWeekTask.hidden = false;
      return;
    }

    const row = document.createElement("div");
    row.className = `main-task-row${mainTask.isCompleted ? " is-completed" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = mainTask.isCompleted;
    checkbox.dataset.action = "toggle-main-task";
    checkbox.setAttribute("aria-label", mainTask.isCompleted ? "Вернуть главное дело в активные" : "Выполнить главное дело");
    const title = document.createElement("strong");
    title.textContent = mainTask.title;
    row.append(checkbox, title);
    elements.mainWeekTaskContent.append(row);

    const actions = document.createElement("div");
    actions.className = "main-task-actions";
    [["edit-main-task", "Изменить"], ["copy-main-task", "В другую неделю"], ["delete-main-task", "Удалить"]]
      .forEach(([action, text]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.textContent = text;
        actions.append(button);
      });
    elements.mainWeekTaskContent.append(actions);
    elements.selectMainWeekTask.hidden = true;
  }

  function createDayPreview(date) {
    const dateKey = toLocalDateKey(date);
    const todayKey = toLocalDateKey(new Date());
    const tasks = getTasksForDate(dateKey);
    const allActiveTasks = tasks.filter((task) => !task.isCompleted);
    const activeTasks = allActiveTasks.slice(0, 3);
    const progress = getProgress(tasks);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day-preview";
    button.dataset.date = dateKey;
    button.setAttribute("aria-pressed", String(dateKey === selectedDate));
    button.setAttribute("aria-label", new Intl.DateTimeFormat("ru-RU", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(date));

    if (dateKey === selectedDate) {
      button.classList.add("is-selected");
    }
    if (dateKey === todayKey) {
      button.classList.add("is-today");
      button.setAttribute("aria-current", "date");
    }

    const weekday = document.createElement("span");
    weekday.className = "preview-weekday";
    weekday.textContent = new Intl.DateTimeFormat("ru-RU", { weekday: "short" })
      .format(date)
      .replace(".", "");

    const dayNumber = document.createElement("span");
    dayNumber.className = "preview-date";
    dayNumber.textContent = String(date.getDate());

    const progressPercentage = progress.total === 0
      ? 0
      : Math.round((progress.completed / progress.total) * 100);
    const progressRing = document.createElement("span");
    progressRing.className = "preview-progress";
    progressRing.style.setProperty("--preview-progress-angle", `${progressPercentage * 3.6}deg`);
    const progressText = document.createElement("span");
    progressText.textContent = progress.total === 0 ? "—" : `${progressPercentage}%`;
    progressRing.append(progressText);

    button.append(weekday, dayNumber);
    if (dateKey === todayKey) {
      const todayMarker = document.createElement("span");
      todayMarker.className = "preview-today";
      todayMarker.textContent = "Сегодня";
      button.append(todayMarker);
    }
    button.append(progressRing);

    if (activeTasks.length === 0) {
      const empty = document.createElement("span");
      empty.className = "preview-empty";
      empty.textContent = "Нет активных задач";
      button.append(empty);
    } else {
      activeTasks.forEach((task) => {
        const item = document.createElement("span");
        item.className = "preview-empty";
        item.textContent = typeof task.title === "string" ? task.title : "Задача";
        button.append(item);
      });
      if (allActiveTasks.length > 3) {
        const more = document.createElement("span");
        more.className = "preview-more";
        more.textContent = `+${allActiveTasks.length - 3} ещё`;
        button.append(more);
      }
    }

    const count = document.createElement("span");
    count.className = "preview-count";
    count.textContent = `${progress.completed} из ${progress.total} выполнено`;
    button.append(count);
    return button;
  }

  function renderWeekStrip() {
    elements.weekStrip.replaceChildren(
      ...getWeekDates(visibleWeekStart).map(createDayPreview),
    );
  }

  function renderSettings() {
    elements.settingShowCompleted.checked = appState.settings.showCompleted;
    elements.settingShowMotivation.checked = appState.settings.showMotivation;
    elements.settingCategoryInputs.forEach((input) => {
      input.checked = appState.settings.enabledCategoryIds.includes(input.value);
    });
  }

  function renderAll() {
    renderHeader();
    renderSelectedDay();
    renderWeekIntentions();
    renderOverdue();
    renderInbox();
    renderWeekStrip();
    renderSettings();
  }

  // 7. Обработчики пользовательских действий
  function selectWeek(weekStart, preferredDate = null) {
    visibleWeekStart = getWeekStart(weekStart);
    selectedDate = preferredDate && isSameWeek(visibleWeekStart, preferredDate)
      ? toLocalDateKey(preferredDate)
      : toLocalDateKey(visibleWeekStart);
    renderAll();
  }

  function moveVisibleWeek(amount) {
    selectWeek(addDays(visibleWeekStart, amount * 7));
  }

  function goToToday() {
    const today = new Date();
    selectWeek(getWeekStart(today), today);
  }

  function showFieldError(input, errorElement, message) {
    input.setAttribute("aria-invalid", "true");
    errorElement.textContent = message;
    errorElement.hidden = false;
    input.focus();
  }

  function clearFieldError(input, errorElement) {
    input.removeAttribute("aria-invalid");
    errorElement.textContent = "";
    errorElement.hidden = true;
  }

  function handleWeekStripClick(event) {
    const dayButton = event.target.closest("[data-date]");
    if (!dayButton || !elements.weekStrip.contains(dayButton)) {
      return;
    }

    selectedDate = dayButton.dataset.date;
    renderAll();
  }

  async function handleDayTaskSubmit(event) {
    event.preventDefault();
    const title = normalizeTaskTitle(elements.dayTaskInput.value);
    if (!title) {
      showFieldError(elements.dayTaskInput, elements.dayTaskError, "Введите название задачи.");
      return;
    }
    clearFieldError(elements.dayTaskInput, elements.dayTaskError);
    const created = await createTask(title, selectedDate);
    if (created) {
      elements.dayTaskInput.value = "";
      elements.dayTaskInput.focus();
    }
  }

  async function handleInboxTaskSubmit(event) {
    event.preventDefault();
    const title = normalizeTaskTitle(elements.inboxTaskInput.value);
    if (!title) {
      showFieldError(elements.inboxTaskInput, elements.inboxTaskError, "Введите название задачи.");
      return;
    }
    clearFieldError(elements.inboxTaskInput, elements.inboxTaskError);
    const created = await createTask(title, null);
    if (created) {
      elements.inboxTaskInput.value = "";
      elements.inboxTaskInput.focus();
    }
  }

  function openModal(dialog, returnFocusTo = document.activeElement) {
    if (returnFocusTo instanceof HTMLElement) {
      dialogReturnFocus.set(dialog, returnFocusTo);
    }
    dialog.showModal();
  }

  function handleDialogBackdropClick(event) {
    const openDialogs = Array.from(document.querySelectorAll("dialog[open]"));
    const dialog = openDialogs.at(-1);
    if (!dialog) {
      return;
    }
    const bounds = dialog.getBoundingClientRect();
    const clickedOutside = event.clientX < bounds.left
      || event.clientX > bounds.right
      || event.clientY < bounds.top
      || event.clientY > bounds.bottom;
    if (clickedOutside) {
      event.preventDefault();
      dialog.close("cancel");
    }
  }

  function restoreFocusAfterDialog(event) {
    const dialog = event.currentTarget;
    const returnTarget = dialogReturnFocus.get(dialog);
    dialogReturnFocus.delete(dialog);
    globalThis.setTimeout(() => {
      if (!document.querySelector("dialog[open]") && returnTarget?.isConnected) {
        returnTarget.focus();
      }
    }, 0);
  }

  function requestConfirmation(message, action, acceptText = "Продолжить", title = "Подтвердите действие") {
    pendingConfirmation = action;
    elements.confirmDialog.returnValue = "";
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmAccept.textContent = acceptText;
    openModal(elements.confirmDialog);
  }

  async function handleConfirmationClose() {
    const action = pendingConfirmation;
    pendingConfirmation = null;
    if (elements.confirmDialog.returnValue === "confirm" && action) {
      await action();
    }
  }

  async function performOverdueCopy(taskId, targetDate) {
    const copyId = await copyTask(taskId, targetDate);
    if (copyId) {
      showToast(targetDate === null ? "Копия добавлена во Входящие." : "Копия добавлена в выбранный день.");
    }
  }

  async function copyOverdueTask(taskId, targetDate) {
    const hasCopy = appState.tasks.some((task) => task.sourceTaskId === taskId);
    const action = () => performOverdueCopy(taskId, targetDate);
    if (hasCopy) {
      requestConfirmation("Для этой задачи уже создана копия. Создать ещё одну?", action, "Создать ещё");
    } else {
      await action();
    }
  }

  function populateCopyTargets() {
    elements.copyTaskTarget.replaceChildren();
    const formatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });
    getWeekDates(visibleWeekStart).forEach((date) => {
      elements.copyTaskTarget.append(new Option(capitalize(formatter.format(date)), toLocalDateKey(date)));
    });
    elements.copyTaskTarget.append(new Option("Другая дата…", "custom"));
    elements.copyTaskTarget.value = selectedDate;
    handleCopyTargetChange();
  }

  function openOverdueCopyDialog(taskId) {
    elements.copyTaskId.value = taskId;
    clearFieldError(elements.copyTaskDate, elements.copyDateError);
    populateCopyTargets();
    openModal(elements.copyTaskDialog);
  }

  function handleCopyTargetChange() {
    const isCustom = elements.copyTaskTarget.value === "custom";
    elements.copyCustomDateField.hidden = !isCustom;
    elements.copyTaskDate.required = isCustom;
    if (!isCustom) {
      clearFieldError(elements.copyTaskDate, elements.copyDateError);
    }
  }

  async function handleCopyTaskSubmit(event) {
    event.preventDefault();
    let targetDate = elements.copyTaskTarget.value;
    if (targetDate === "custom") {
      targetDate = elements.copyTaskDate.value;
      if (!parseLocalDate(targetDate)) {
        showFieldError(elements.copyTaskDate, elements.copyDateError, "Выберите корректную дату.");
        return;
      }
    }
    const taskId = elements.copyTaskId.value;
    elements.copyTaskDialog.close();
    await copyOverdueTask(taskId, targetDate);
  }

  async function handleOverdueClick(event) {
    const button = event.target.closest("[data-action]");
    const card = event.target.closest(".overdue-card");
    if (!button || !card) {
      return;
    }
    const taskId = card.dataset.taskId;
    const task = appState.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    switch (button.dataset.action) {
      case "copy-overdue-today":
        await copyOverdueTask(taskId, toLocalDateKey(new Date()));
        break;
      case "copy-overdue-other":
        openOverdueCopyDialog(taskId);
        break;
      case "copy-overdue-inbox":
        await copyOverdueTask(taskId, null);
        break;
      case "complete-overdue":
        await toggleTaskCompletion(taskId);
        break;
      case "edit-overdue":
        openTaskEditor(task);
        break;
      case "delete-overdue":
        await deleteTask(taskId);
        break;
      default:
        break;
    }
  }

  function scheduleDayNoteSave() {
    if (dayNoteTimerId !== null) {
      globalThis.clearTimeout(dayNoteTimerId);
    }
    const dateKey = selectedDate;
    const value = elements.dayNote.value;
    dayNoteTimerId = globalThis.setTimeout(async () => {
      dayNoteTimerId = null;
      await saveDayNote(dateKey, value);
    }, 400);
  }

  async function flushDayNoteSave() {
    if (dayNoteTimerId === null) {
      return;
    }
    globalThis.clearTimeout(dayNoteTimerId);
    dayNoteTimerId = null;
    await saveDayNote(selectedDate, elements.dayNote.value);
  }

  async function saveVisibleWeekGoal() {
    const weekStartKey = toLocalDateKey(visibleWeekStart);
    const saved = await saveWeekGoal(weekStartKey, elements.weekGoal.value);
    if (saved) {
      elements.weekGoalStatus.textContent = elements.weekGoal.value.trim() ? "Сохранено" : "Цель очищена";
      globalThis.setTimeout(() => {
        elements.weekGoalStatus.textContent = "";
      }, 1800);
    }
  }

  function openMainTaskEditor() {
    const weekStartKey = toLocalDateKey(visibleWeekStart);
    const task = appState.weekMainTasks[weekStartKey] ?? null;
    editingMainTaskId = task?.id ?? null;
    elements.mainTaskTitleInput.value = task?.title ?? "";
    clearFieldError(elements.mainTaskTitleInput, elements.mainTaskTitleError);
    openModal(elements.mainTaskDialog);
    elements.mainTaskTitleInput.focus();
  }

  async function handleMainTaskSubmit(event) {
    event.preventDefault();
    const title = normalizeTaskTitle(elements.mainTaskTitleInput.value);
    if (!title) {
      showFieldError(elements.mainTaskTitleInput, elements.mainTaskTitleError, "Введите название.");
      return;
    }
    const weekStartKey = toLocalDateKey(visibleWeekStart);
    if (editingMainTaskId && appState.weekMainTasks[weekStartKey]?.id !== editingMainTaskId) {
      elements.mainTaskDialog.close();
      showToast("Главное дело уже удалено в другой вкладке.");
      return;
    }
    const saved = await saveMainWeekTask(weekStartKey, title);
    if (saved) {
      editingMainTaskId = null;
      elements.mainTaskDialog.close();
    }
  }

  function openMainCopyDialog() {
    elements.mainCopyDate.value = "";
    clearFieldError(elements.mainCopyDate, elements.mainCopyError);
    openModal(elements.mainCopyDialog);
  }

  function handleMainCopySubmit(event) {
    event.preventDefault();
    const date = parseLocalDate(elements.mainCopyDate.value);
    if (!date) {
      showFieldError(elements.mainCopyDate, elements.mainCopyError, "Выберите корректную дату.");
      return;
    }
    const sourceWeek = toLocalDateKey(visibleWeekStart);
    const targetWeek = toLocalDateKey(getWeekStart(date));
    if (sourceWeek === targetWeek) {
      showFieldError(elements.mainCopyDate, elements.mainCopyError, "Выберите другую неделю.");
      return;
    }
    const replacesExisting = Boolean(appState.weekMainTasks[targetWeek]);
    elements.mainCopyDialog.close();
    requestConfirmation(
      replacesExisting
        ? "В выбранной неделе уже есть главное дело. Заменить его копией?"
        : "Создать копию главного дела в выбранной неделе?",
      async () => {
        const copied = await copyMainWeekTask(sourceWeek, targetWeek);
        if (copied) {
          showToast("Главное дело скопировано в другую неделю.");
        }
      },
      replacesExisting ? "Заменить" : "Скопировать",
    );
  }

  async function handleMainWeekTaskClick(event) {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const weekStartKey = toLocalDateKey(visibleWeekStart);
    if (action === "edit-main-task") {
      openMainTaskEditor();
    } else if (action === "copy-main-task") {
      openMainCopyDialog();
    } else if (action === "delete-main-task") {
      await deleteMainWeekTask(weekStartKey);
    }
  }

  async function handleMainWeekTaskChange(event) {
    if (event.target.dataset.action === "toggle-main-task") {
      await toggleMainWeekTask(toLocalDateKey(visibleWeekStart));
    }
  }

  function handleQuickAddKeydown(event) {
    if (event.key !== "Enter" || event.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function getTaskFromEvent(event) {
    const card = event.target.closest(".task-card");
    if (!card) {
      return null;
    }
    return appState.tasks.find((task) => task.id === card.dataset.taskId) ?? null;
  }

  async function handleTaskListChange(event) {
    if (event.target.dataset.action !== "toggle-task") {
      return;
    }
    const task = getTaskFromEvent(event);
    if (task) {
      await toggleTaskCompletion(task.id);
    }
  }

  async function handleTaskListClick(event) {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action || action === "toggle-task" || action === "inline-rename") {
      return;
    }
    const task = getTaskFromEvent(event);
    if (!task) {
      return;
    }

    if (action === "edit-task") {
      openTaskEditor(task);
    } else if (action === "move-task") {
      openMoveTaskDialog(task);
    } else if (action === "delete-task") {
      await deleteTask(task.id);
    }
  }

  function handleTaskListDoubleClick(event) {
    if (!event.target.matches(".task-title")) {
      return;
    }
    const task = getTaskFromEvent(event);
    if (task) {
      startInlineRename(event.target, task);
    }
  }

  function handleTaskListKeydown(event) {
    if (event.target.matches(".task-title") && (event.key === "Enter" || event.key === "F2")) {
      event.preventDefault();
      const task = getTaskFromEvent(event);
      if (task) {
        startInlineRename(event.target, task);
      }
    }
  }

  function captureInlineRenameDraft() {
    const input = document.querySelector(".inline-title-input");
    const card = input?.closest(".task-card");
    if (!input || !card) {
      return null;
    }
    return {
      taskId: card.dataset.taskId,
      value: input.value,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    };
  }

  function restoreInlineRenameDraft(draft) {
    if (!draft) {
      return;
    }
    const task = appState.tasks.find((item) => item.id === draft.taskId);
    const card = Array.from(document.querySelectorAll(".task-card"))
      .find((item) => item.dataset.taskId === draft.taskId);
    const titleElement = card?.querySelector(".task-title");
    if (!task || !titleElement) {
      return;
    }
    const input = startInlineRename(titleElement, task, draft.value, false);
    input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
    const message = document.createElement("small");
    message.className = "inline-sync-message";
    message.textContent = "Данные изменились в другой вкладке";
    message.setAttribute("aria-live", "polite");
    input.after(message);
  }

  function startInlineRename(titleElement, task, initialValue = task.title, selectText = true) {
    if (titleElement.querySelector("input")) {
      return null;
    }
    const input = document.createElement("input");
    input.className = "inline-title-input";
    input.type = "text";
    input.maxLength = TASK_TITLE_LIMIT;
    input.value = initialValue;
    titleElement.replaceWith(input);
    input.focus();
    if (selectText) {
      input.select();
    }

    let finished = false;
    const cancel = () => {
      if (!finished) {
        finished = true;
        renderAll();
      }
    };
    input.addEventListener("keydown", async (event) => {
      if (event.key === "Escape") {
        cancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        const title = normalizeTaskTitle(input.value);
        if (!title) {
          input.setCustomValidity("Название не может быть пустым");
          input.reportValidity();
          return;
        }
        finished = true;
        await updateTask(task.id, { title });
      }
    });
    input.addEventListener("blur", () => {
      if (!suppressInlineRenameBlur) {
        cancel();
      }
    }, { once: true });
    return input;
  }

  function populateCategoryOptions(currentCategoryId = null) {
    elements.editTaskCategory.replaceChildren(new Option("Без категории", ""));
    appState.settings.enabledCategoryIds.forEach((id) => {
      elements.editTaskCategory.append(new Option(CATEGORIES[id].label, id));
    });
    if (currentCategoryId && !appState.settings.enabledCategoryIds.includes(currentCategoryId)) {
      elements.editTaskCategory.append(new Option(`${CATEGORIES[currentCategoryId].label} (скрыта)`, currentCategoryId));
    }
    elements.editTaskCategory.value = currentCategoryId ?? "";
  }

  function openTaskEditor(task) {
    elements.editTaskId.value = task.id;
    elements.editTaskTitle.value = task.title;
    elements.editTaskNote.value = task.note;
    populateCategoryOptions(task.categoryId);
    elements.editTaskImportant.checked = task.isImportant;
    clearFieldError(elements.editTaskTitle, elements.editTitleError);
    openModal(elements.taskEditDialog);
    elements.editTaskTitle.focus();
    elements.editTaskTitle.select();
  }

  async function handleTaskEditSubmit(event) {
    event.preventDefault();
    const title = normalizeTaskTitle(elements.editTaskTitle.value);
    if (!title) {
      showFieldError(elements.editTaskTitle, elements.editTitleError, "Введите название задачи.");
      return;
    }
    const updated = await updateTask(elements.editTaskId.value, {
      title,
      note: elements.editTaskNote.value,
      categoryId: elements.editTaskCategory.value || null,
      isImportant: elements.editTaskImportant.checked,
    });
    if (updated) {
      elements.taskEditDialog.close();
    }
  }

  function populateMoveTargets(task) {
    elements.moveTaskTarget.replaceChildren();
    const inboxOption = new Option("Входящие", "inbox");
    elements.moveTaskTarget.append(inboxOption);
    const formatter = new Intl.DateTimeFormat("ru-RU", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    getWeekDates(visibleWeekStart).forEach((date) => {
      const option = new Option(capitalize(formatter.format(date)), toLocalDateKey(date));
      elements.moveTaskTarget.append(option);
    });
    elements.moveTaskTarget.append(new Option("Другая дата…", "custom"));

    const taskIsInVisibleWeek = task.date && getWeekDates(visibleWeekStart)
      .some((date) => toLocalDateKey(date) === task.date);
    elements.moveTaskTarget.value = task.date === null
      ? "inbox"
      : taskIsInVisibleWeek ? task.date : "custom";
    elements.moveTaskDate.value = task.date ?? "";
    handleMoveTargetChange();
  }

  function openMoveTaskDialog(task) {
    elements.moveTaskId.value = task.id;
    clearFieldError(elements.moveTaskDate, elements.moveDateError);
    populateMoveTargets(task);
    openModal(elements.moveTaskDialog);
    elements.moveTaskTarget.focus();
  }

  function handleMoveTargetChange() {
    const isCustom = elements.moveTaskTarget.value === "custom";
    elements.customDateField.hidden = !isCustom;
    elements.moveTaskDate.required = isCustom;
    if (!isCustom) {
      clearFieldError(elements.moveTaskDate, elements.moveDateError);
    }
  }

  async function handleMoveTaskSubmit(event) {
    event.preventDefault();
    let targetDate = elements.moveTaskTarget.value;
    if (targetDate === "inbox") {
      targetDate = null;
    } else if (targetDate === "custom") {
      targetDate = elements.moveTaskDate.value;
      if (!parseLocalDate(targetDate)) {
        showFieldError(elements.moveTaskDate, elements.moveDateError, "Выберите корректную дату.");
        return;
      }
    }

    const moved = await moveTask(elements.moveTaskId.value, targetDate);
    if (moved) {
      elements.moveTaskDialog.close();
      showToast("Задача перемещена.");
    }
  }

  // 8. Перетаскивание указателем
  function parseListDate(value) {
    return value === "inbox" ? null : value;
  }

  function clearDropHighlights() {
    document.querySelectorAll(".is-drag-over").forEach((element) => {
      element.classList.remove("is-drag-over");
    });
    document.querySelectorAll(".drag-placeholder").forEach((element) => element.remove());
  }

  function isDateInVisibleWeek(dateKey) {
    return Boolean(dateKey) && getWeekDates(visibleWeekStart)
      .some((date) => toLocalDateKey(date) === dateKey);
  }

  function showPointerDropTarget(dropTarget) {
    if (!dropTarget) {
      return;
    }
    dropTarget.element.classList.add("is-drag-over");
    const list = dropTarget.element.closest(".task-list");
    if (!list) {
      return;
    }
    const placeholder = document.createElement("div");
    placeholder.className = "drag-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    const beforeCard = dropTarget.beforeTaskId
      ? Array.from(list.querySelectorAll(".task-card"))
        .find((card) => card.dataset.taskId === dropTarget.beforeTaskId)
      : null;
    list.insertBefore(placeholder, beforeCard ?? null);
  }

  function clearPointerDrag() {
    pointerDrag?.ghost?.remove();
    pointerDrag = null;
    document.body.classList.remove("is-drag-active");
    document.querySelectorAll(".is-dragging").forEach((element) => element.classList.remove("is-dragging"));
    clearDropHighlights();
  }

  function getPointerDropTarget(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) {
      return null;
    }

    const day = element.closest(".day-preview");
    if (day) {
      return { element: day, date: day.dataset.date, beforeTaskId: null };
    }

    const inboxButton = element.closest("#inbox-button");
    if (inboxButton) {
      return { element: inboxButton, date: null, beforeTaskId: null };
    }

    const list = element.closest(".task-list");
    if (list) {
      return {
        element: element.closest(".task-card") ?? list,
        date: parseListDate(list.dataset.listDate),
        beforeTaskId: element.closest(".task-card")?.dataset.taskId ?? null,
      };
    }

    return null;
  }

  function handlePointerDragStart(event) {
    if (event.button !== 0 || pointerDrag) {
      return;
    }

    const handle = event.target.closest(".drag-handle");
    const card = handle?.closest(".task-card, .overdue-card");
    if (!handle || !card || !event.currentTarget.contains(card)) {
      return;
    }

    event.preventDefault();
    pointerDrag = {
      pointerId: event.pointerId,
      taskId: card.dataset.taskId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      mode: card.classList.contains("overdue-card") ? "copy-overdue" : "move",
      card,
      ghost: null,
    };
    handle.setPointerCapture?.(event.pointerId);
  }

  function handlePointerDragMove(event) {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    const distance = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY);
    if (!pointerDrag.active && distance < 6) {
      return;
    }

    event.preventDefault();
    if (!pointerDrag.active) {
      pointerDrag.active = true;
      pointerDrag.card.classList.add("is-dragging");
      document.body.classList.add("is-drag-active");
      const task = appState.tasks.find((item) => item.id === pointerDrag.taskId);
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = task?.title ?? "Задача";
      document.body.append(ghost);
      pointerDrag.ghost = ghost;
    }

    pointerDrag.ghost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 14}px)`;
    clearDropHighlights();
    const dropTarget = getPointerDropTarget(event.clientX, event.clientY);
    const allowedTarget = pointerDrag.mode === "copy-overdue"
      ? dropTarget && isDateInVisibleWeek(dropTarget.date) ? dropTarget : null
      : dropTarget;
    showPointerDropTarget(allowedTarget);
  }

  async function handlePointerDragEnd(event) {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) {
      return;
    }

    const { active, taskId, mode } = pointerDrag;
    const candidateTarget = active ? getPointerDropTarget(event.clientX, event.clientY) : null;
    const dropTarget = mode === "copy-overdue"
      ? candidateTarget && isDateInVisibleWeek(candidateTarget.date) ? candidateTarget : null
      : candidateTarget;
    clearPointerDrag();
    if (!active || !dropTarget || dropTarget.beforeTaskId === taskId) {
      return;
    }

    if (mode === "copy-overdue") {
      await copyOverdueTask(taskId, dropTarget.date);
      return;
    }

    const moved = await moveTask(taskId, dropTarget.date, dropTarget.beforeTaskId);
    if (moved) {
      showToast(dropTarget.date === null ? "Задача перенесена во Входящие." : "Задача перенесена на выбранный день.");
    }
  }

  // 9. Панели, модальные окна и уведомления
  function openInbox() {
    inboxWasOpenedBy = document.activeElement;
    elements.inboxPanel.classList.add("is-open");
    elements.inboxPanel.setAttribute("aria-hidden", "false");
    elements.inboxButton.setAttribute("aria-expanded", "true");
    elements.panelBackdrop.hidden = false;
    elements.inboxTaskInput.focus();
  }

  function toggleInbox() {
    if (elements.inboxPanel.classList.contains("is-open")) {
      closeInbox();
    } else {
      openInbox();
    }
  }

  function closeInbox() {
    if (!elements.inboxPanel.classList.contains("is-open")) {
      return;
    }

    elements.inboxPanel.classList.remove("is-open");
    elements.inboxPanel.setAttribute("aria-hidden", "true");
    elements.inboxButton.setAttribute("aria-expanded", "false");
    elements.panelBackdrop.hidden = true;
    if (inboxWasOpenedBy instanceof HTMLElement) {
      inboxWasOpenedBy.focus();
    }
    inboxWasOpenedBy = null;
  }

  function showToast(message, duration = 5000) {
    if (!elements.toastRegion) {
      return;
    }

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    elements.toastRegion.replaceChildren(toast);
    globalThis.setTimeout(() => {
      if (toast.isConnected) {
        toast.remove();
      }
    }, duration);
  }

  function clearUndoDeletion() {
    if (undoTimerId !== null) {
      globalThis.clearTimeout(undoTimerId);
      undoTimerId = null;
    }
    undoDeletion = null;
    elements.toastRegion?.querySelector(".undo-toast")?.remove();
  }

  function registerUndoDeletion(snapshot) {
    clearUndoDeletion();
    undoDeletion = {
      snapshot,
      expiresAt: Date.now() + UNDO_DURATION,
    };

    const toast = document.createElement("div");
    toast.className = "toast undo-toast";
    const text = document.createElement("span");
    text.textContent = snapshot.type === "main-task" ? "Главное дело удалено" : "Задача удалена";
    const undoButton = document.createElement("button");
    undoButton.type = "button";
    undoButton.className = "toast-action";
    undoButton.textContent = "Отменить";
    undoButton.addEventListener("click", restoreLastDeletedTask, { once: true });
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "toast-close";
    closeButton.setAttribute("aria-label", "Закрыть без восстановления");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", clearUndoDeletion, { once: true });
    toast.append(text, undoButton, closeButton);
    elements.toastRegion.replaceChildren(toast);

    undoTimerId = globalThis.setTimeout(() => {
      clearUndoDeletion();
      if (toast.isConnected) {
        toast.remove();
      }
    }, UNDO_DURATION);
  }

  function closeEditorsForMissingTasks() {
    if (elements.taskEditDialog.open) {
      const taskExists = appState.tasks.some((task) => task.id === elements.editTaskId.value);
      if (!taskExists) {
        elements.taskEditDialog.close();
      }
    }
    if (elements.moveTaskDialog.open) {
      const taskExists = appState.tasks.some((task) => task.id === elements.moveTaskId.value);
      if (!taskExists) {
        elements.moveTaskDialog.close();
      }
    }
    if (elements.copyTaskDialog.open) {
      const taskExists = appState.tasks.some((task) => task.id === elements.copyTaskId.value);
      if (!taskExists) {
        elements.copyTaskDialog.close();
      }
    }
    if (elements.mainTaskDialog.open && editingMainTaskId) {
      const taskExists = Object.values(appState.weekMainTasks).some((task) => task.id === editingMainTaskId);
      if (!taskExists) {
        editingMainTaskId = null;
        elements.mainTaskDialog.close();
      }
    }
  }

  function openSettings() {
    renderSettings();
    openModal(elements.settingsDialog, elements.settingsButton);
  }

  async function handleSettingsChange(event) {
    if (event.target === elements.settingShowCompleted) {
      await updateSettings({ showCompleted: event.target.checked });
      return;
    }
    if (event.target === elements.settingShowMotivation) {
      await updateSettings({ showMotivation: event.target.checked });
      return;
    }
    if (elements.settingCategoryInputs.includes(event.target)) {
      const enabledCategoryIds = elements.settingCategoryInputs
        .filter((input) => input.checked)
        .map((input) => input.value);
      await updateSettings({ enabledCategoryIds });
    }
  }

  function requestDeleteAllData() {
    elements.settingsDialog.close();
    requestConfirmation(
      "Будут удалены все задачи, заметки, цели и настройки. Отменить это действие нельзя.",
      deleteAllData,
      "Удалить всё",
      "Удалить все данные?",
    );
  }

  function handleGlobalKeydown(event) {
    if (event.key === "Escape" && pointerDrag) {
      clearPointerDrag();
      return;
    }
    const openDialogs = Array.from(document.querySelectorAll("dialog[open]"));
    if (event.key === "Escape" && openDialogs.length > 0) {
      event.preventDefault();
      openDialogs.at(-1).close("cancel");
      return;
    }
    if (event.key === "Escape" && elements.inboxPanel.classList.contains("is-open")) {
      closeInbox();
    }
  }

  // 10. Инициализация приложения
  function collectElements() {
    Object.assign(elements, {
      previousWeek: document.querySelector("#previous-week"),
      nextWeek: document.querySelector("#next-week"),
      todayButton: document.querySelector("#today-button"),
      weekPeriod: document.querySelector("#week-period"),
      weekProgress: document.querySelector("#week-progress"),
      weekProgressTrack: document.querySelector("#week-progress-track"),
      weekCompletedCount: document.querySelector("#week-completed-count"),
      weekRemainingCount: document.querySelector("#week-remaining-count"),
      weekTotalCount: document.querySelector("#week-total-count"),
      weekMotivation: document.querySelector("#week-motivation"),
      overdueSection: document.querySelector("#overdue-section"),
      overdueToggle: document.querySelector("#overdue-toggle"),
      overdueCount: document.querySelector("#overdue-count"),
      overdueList: document.querySelector("#overdue-list"),
      inboxButton: document.querySelector("#inbox-button"),
      inboxCount: document.querySelector("#inbox-count"),
      weekStrip: document.querySelector("#week-strip"),
      selectedDayTitle: document.querySelector("#selected-day-title"),
      selectedDayDate: document.querySelector("#selected-day-date"),
      selectedDayToday: document.querySelector("#selected-day-today"),
      dayProgress: document.querySelector("#day-progress"),
      motivationMessage: document.querySelector("#motivation-message"),
      dayMotivation: document.querySelector("#day-motivation"),
      dragInstruction: document.querySelector("#drag-instruction"),
      dayTaskForm: document.querySelector("#day-task-form"),
      dayTaskInput: document.querySelector("#day-task-input"),
      dayTaskError: document.querySelector("#day-task-error"),
      selectedDayTasks: document.querySelector("#selected-day-tasks"),
      dayNote: document.querySelector("#day-note"),
      weekGoal: document.querySelector("#week-goal"),
      weekGoalStatus: document.querySelector("#week-goal-status"),
      mainWeekTaskContent: document.querySelector("#main-week-task-content"),
      selectMainWeekTask: document.querySelector("#select-main-week-task"),
      inboxPanel: document.querySelector("#inbox-panel"),
      closeInbox: document.querySelector("#close-inbox"),
      inboxTaskForm: document.querySelector("#inbox-task-form"),
      inboxTaskInput: document.querySelector("#inbox-task-input"),
      inboxTaskError: document.querySelector("#inbox-task-error"),
      inboxTasks: document.querySelector("#inbox-tasks"),
      panelBackdrop: document.querySelector("#panel-backdrop"),
      taskEditDialog: document.querySelector("#task-edit-dialog"),
      taskEditForm: document.querySelector("#task-edit-form"),
      closeTaskEdit: document.querySelector("#close-task-edit"),
      cancelTaskEdit: document.querySelector("#cancel-task-edit"),
      editTaskId: document.querySelector("#edit-task-id"),
      editTaskTitle: document.querySelector("#edit-task-title"),
      editTaskNote: document.querySelector("#edit-task-note"),
      editTaskCategory: document.querySelector("#edit-task-category"),
      editTaskImportant: document.querySelector("#edit-task-important"),
      editTitleError: document.querySelector("#edit-title-error"),
      moveTaskDialog: document.querySelector("#move-task-dialog"),
      moveTaskForm: document.querySelector("#move-task-form"),
      closeMoveTask: document.querySelector("#close-move-task"),
      cancelMoveTask: document.querySelector("#cancel-move-task"),
      moveTaskId: document.querySelector("#move-task-id"),
      moveTaskTarget: document.querySelector("#move-task-target"),
      moveTaskDate: document.querySelector("#move-task-date"),
      moveDateError: document.querySelector("#move-date-error"),
      customDateField: document.querySelector("#custom-date-field"),
      copyTaskDialog: document.querySelector("#copy-task-dialog"),
      copyTaskForm: document.querySelector("#copy-task-form"),
      closeCopyTask: document.querySelector("#close-copy-task"),
      cancelCopyTask: document.querySelector("#cancel-copy-task"),
      copyTaskId: document.querySelector("#copy-task-id"),
      copyTaskTarget: document.querySelector("#copy-task-target"),
      copyTaskDate: document.querySelector("#copy-task-date"),
      copyDateError: document.querySelector("#copy-date-error"),
      copyCustomDateField: document.querySelector("#copy-custom-date-field"),
      mainTaskDialog: document.querySelector("#main-task-dialog"),
      mainTaskForm: document.querySelector("#main-task-form"),
      closeMainTask: document.querySelector("#close-main-task"),
      cancelMainTask: document.querySelector("#cancel-main-task"),
      mainTaskTitleInput: document.querySelector("#main-task-title-input"),
      mainTaskTitleError: document.querySelector("#main-task-title-error"),
      mainCopyDialog: document.querySelector("#main-copy-dialog"),
      mainCopyForm: document.querySelector("#main-copy-form"),
      closeMainCopy: document.querySelector("#close-main-copy"),
      cancelMainCopy: document.querySelector("#cancel-main-copy"),
      mainCopyDate: document.querySelector("#main-copy-date"),
      mainCopyError: document.querySelector("#main-copy-error"),
      confirmDialog: document.querySelector("#confirm-dialog"),
      confirmTitle: document.querySelector("#confirm-title"),
      confirmMessage: document.querySelector("#confirm-message"),
      confirmAccept: document.querySelector("#confirm-accept"),
      settingsButton: document.querySelector("#settings-button"),
      settingsDialog: document.querySelector("#settings-dialog"),
      settingShowCompleted: document.querySelector("#setting-show-completed"),
      settingShowMotivation: document.querySelector("#setting-show-motivation"),
      settingCategoryInputs: CATEGORY_IDS.map((id) => document.querySelector(`#setting-category-${id}`)),
      deleteAllData: document.querySelector("#delete-all-data"),
      toastRegion: document.querySelector("#toast-region"),
    });
  }

  function bindTaskListEvents(container) {
    container.addEventListener("click", handleTaskListClick);
    container.addEventListener("change", handleTaskListChange);
    container.addEventListener("dblclick", handleTaskListDoubleClick);
    container.addEventListener("keydown", handleTaskListKeydown);
    container.addEventListener("pointerdown", handlePointerDragStart);
  }

  function bindEvents() {
    elements.previousWeek.addEventListener("click", () => moveVisibleWeek(-1));
    elements.nextWeek.addEventListener("click", () => moveVisibleWeek(1));
    elements.todayButton.addEventListener("click", goToToday);
    elements.weekStrip.addEventListener("click", handleWeekStripClick);
    elements.overdueToggle.addEventListener("click", () => {
      const expanded = elements.overdueToggle.getAttribute("aria-expanded") === "true";
      elements.overdueToggle.setAttribute("aria-expanded", String(!expanded));
      elements.overdueList.hidden = expanded;
    });
    elements.overdueList.addEventListener("click", handleOverdueClick);
    elements.overdueList.addEventListener("pointerdown", handlePointerDragStart);
    elements.dayTaskForm.addEventListener("submit", handleDayTaskSubmit);
    elements.inboxTaskForm.addEventListener("submit", handleInboxTaskSubmit);
    elements.dayTaskInput.addEventListener("input", () => clearFieldError(elements.dayTaskInput, elements.dayTaskError));
    elements.inboxTaskInput.addEventListener("input", () => clearFieldError(elements.inboxTaskInput, elements.inboxTaskError));
    elements.dayTaskInput.addEventListener("keydown", handleQuickAddKeydown);
    elements.inboxTaskInput.addEventListener("keydown", handleQuickAddKeydown);
    elements.dayNote.addEventListener("input", scheduleDayNoteSave);
    elements.dayNote.addEventListener("blur", flushDayNoteSave);
    elements.weekGoal.addEventListener("blur", saveVisibleWeekGoal);
    elements.weekGoal.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        saveVisibleWeekGoal();
        elements.weekGoal.blur();
      }
    });
    elements.selectMainWeekTask.addEventListener("click", openMainTaskEditor);
    elements.mainWeekTaskContent.addEventListener("click", handleMainWeekTaskClick);
    elements.mainWeekTaskContent.addEventListener("change", handleMainWeekTaskChange);
    bindTaskListEvents(elements.selectedDayTasks);
    bindTaskListEvents(elements.inboxTasks);
    elements.inboxButton.addEventListener("click", toggleInbox);
    elements.closeInbox.addEventListener("click", closeInbox);
    elements.panelBackdrop.addEventListener("click", closeInbox);
    elements.taskEditForm.addEventListener("submit", handleTaskEditSubmit);
    elements.editTaskTitle.addEventListener("input", () => clearFieldError(elements.editTaskTitle, elements.editTitleError));
    elements.closeTaskEdit.addEventListener("click", () => elements.taskEditDialog.close());
    elements.cancelTaskEdit.addEventListener("click", () => elements.taskEditDialog.close());
    elements.moveTaskForm.addEventListener("submit", handleMoveTaskSubmit);
    elements.moveTaskTarget.addEventListener("change", handleMoveTargetChange);
    elements.moveTaskDate.addEventListener("input", () => clearFieldError(elements.moveTaskDate, elements.moveDateError));
    elements.closeMoveTask.addEventListener("click", () => elements.moveTaskDialog.close());
    elements.cancelMoveTask.addEventListener("click", () => elements.moveTaskDialog.close());
    elements.copyTaskForm.addEventListener("submit", handleCopyTaskSubmit);
    elements.copyTaskTarget.addEventListener("change", handleCopyTargetChange);
    elements.copyTaskDate.addEventListener("input", () => clearFieldError(elements.copyTaskDate, elements.copyDateError));
    elements.closeCopyTask.addEventListener("click", () => elements.copyTaskDialog.close());
    elements.cancelCopyTask.addEventListener("click", () => elements.copyTaskDialog.close());
    elements.mainTaskForm.addEventListener("submit", handleMainTaskSubmit);
    elements.mainTaskTitleInput.addEventListener("input", () => clearFieldError(elements.mainTaskTitleInput, elements.mainTaskTitleError));
    elements.closeMainTask.addEventListener("click", () => elements.mainTaskDialog.close());
    elements.cancelMainTask.addEventListener("click", () => elements.mainTaskDialog.close());
    elements.mainCopyForm.addEventListener("submit", handleMainCopySubmit);
    elements.mainCopyDate.addEventListener("input", () => clearFieldError(elements.mainCopyDate, elements.mainCopyError));
    elements.closeMainCopy.addEventListener("click", () => elements.mainCopyDialog.close());
    elements.cancelMainCopy.addEventListener("click", () => elements.mainCopyDialog.close());
    elements.confirmDialog.addEventListener("close", handleConfirmationClose);
    elements.settingsButton.addEventListener("click", openSettings);
    elements.settingsDialog.addEventListener("change", handleSettingsChange);
    elements.deleteAllData.addEventListener("click", requestDeleteAllData);
    document.querySelectorAll("dialog").forEach((dialog) => {
      dialog.addEventListener("close", restoreFocusAfterDialog);
    });
    document.addEventListener("click", handleDialogBackdropClick, true);
    globalThis.addEventListener("pointermove", handlePointerDragMove, { passive: false });
    globalThis.addEventListener("pointerup", handlePointerDragEnd);
    globalThis.addEventListener("pointercancel", clearPointerDrag);
    globalThis.addEventListener("keydown", handleGlobalKeydown);
    globalThis.addEventListener("storage", handleExternalStorageChange);
  }

  async function init() {
    collectElements();
    const loadResult = loadInitialState();
    appState = loadResult.state;
    const today = new Date();
    visibleWeekStart = getWeekStart(today);
    selectedDate = toLocalDateKey(today);
    bindEvents();
    renderAll();
    await ensureCurrentWeekCarryover();

    if (loadResult.recovered) {
      showToast("Повреждённые данные сохранены отдельно. Создан чистый план.", 8000);
    } else if (loadResult.storageError) {
      showToast("Хранилище браузера недоступно. Данные могут потеряться после перезагрузки.", 8000);
    }
  }

  init().catch((error) => {
    console.error("Не удалось запустить планировщик", error);
  });
})();

