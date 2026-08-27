// ==UserScript==
// @name         Clockify no Jira — Apontamentos em lote
// @namespace    local.clockify-jira.apontamentos
// @version      5.4.1
// @description  Preenche e adiciona apontamentos em lote por turnos (Manhã e Tarde) no painel Manual do Clockify dentro do Jira.
// @author       Nmap02
// @match        https://*.clockify.me/*
// @match        https://clockify.me/*
// @match        https://*.atlassian.net/*
// @match        https://*.jira.com/*
// @allFrames    true
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==
//
// Contributors:
// - Joyce Santos: https://github.com/joyce-santos23
// - Nmap02: https://github.com/Nmap02

(function clockifyJiraBulkEntry() {
  "use strict";

  const STORAGE_KEY = "clockify-jira-bulk-entry.config.v1";
  const UI_ID = "clockify-jira-bulk-entry-panel";

  // ============================================================
  // CONFIGURAÇÕES DO SCRIPT
  // ============================================================

  // Intervalo entre os envios dos apontamentos, em milissegundos.
  // Exemplo:
  // 1500 = 1,5 segundos
  // 2000 = 2 segundos
  // 500  = 0,5 segundo
  const DELAY_MS = 1500;

  const SELECTORS = {
    root: "#stopwatch-manual",
    description: "#timeEntryDescriptionManual",
    date: "#datepicker",
    start: "#timeFromManual",
    end: "#timeToManual",
    duration: "#time-input",
    task: "#taskSelectManual",
    tag: "#tagSelectManual",
    submit: "#addButtonManual",
    message: "#messageManual",
  };

  const DEFAULT_CONFIG = Object.freeze({
    configVersion: 2,
    tagName: "",
    taskLabel: "Without task",
    morningStart: "08:45",
    morningEnd: "12:00",
    afternoonStart: "13:00",
    afternoonEnd: "17:45",
    descriptionOverride: "",
  });

  const WEEKDAYS_PT_BR = [
    "domingo",
    "segunda-feira",
    "terça-feira",
    "quarta-feira",
    "quinta-feira",
    "sexta-feira",
    "sábado",
  ];

  let isRunning = false;

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getConfig() {
    let stored = {};

    try {
      stored = GM_getValue(STORAGE_KEY, {});
    } catch (error) {
      console.warn(
        "[Clockify Jira] Não foi possível ler a configuração local.",
        error
      );
    }

    if (!stored.configVersion || stored.configVersion < 2) {
      stored = {
        ...stored,
        configVersion: 2,
        morningStart: "08:45",
        morningEnd: "12:00",
        afternoonStart: "13:00",
        afternoonEnd: "17:45",
      };

      try {
        GM_setValue(STORAGE_KEY, stored);
      } catch (_) {}
    }

    return { ...DEFAULT_CONFIG, ...(stored || {}) };
  }

  function saveConfig(partialConfig) {
    const config = { ...getConfig(), ...partialConfig };
    GM_setValue(STORAGE_KEY, config);
    return config;
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase("pt-BR");
  }

  function getJQuery() {
    return (window.AJS && window.AJS.$) || window.jQuery || window.$ || null;
  }

  function forceSwitchToManual() {
    try {
      const manualBtn =
        document.querySelector("#switchManual") ||
        document.querySelector('a[href="#stopwatch-manual"]') ||
        document.querySelector("#switchManual a") ||
        document.querySelector("#switchManual button");

      if (manualBtn) {
        manualBtn.click();
      }
    } catch (_) {}

    try {
      const manualPane = document.querySelector("#stopwatch-manual");

      if (manualPane) {
        manualPane.style.display = "block";
        manualPane.style.visibility = "visible";
        manualPane.classList.remove("hide", "hidden");
      }
    } catch (_) {}
  }

  function getElements() {
    forceSwitchToManual();

    return {
      root: document.querySelector(SELECTORS.root),
      description: document.querySelector(SELECTORS.description),
      dateInput: document.querySelector(SELECTORS.date),
      startInput: document.querySelector(SELECTORS.start),
      endInput: document.querySelector(SELECTORS.end),
      durationInput: document.querySelector(SELECTORS.duration),
      taskSelect: document.querySelector(SELECTORS.task),
      tagSelect: document.querySelector(SELECTORS.tag),
      addButton: document.querySelector(SELECTORS.submit),
      messageBox: document.querySelector(SELECTORS.message),
    };
  }

  function setNativeValue(element, value) {
    if (!element) return;

    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "value"
    );

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function emit(element, eventName) {
    if (!element) return;

    element.dispatchEvent(
      new Event(eventName, {
        bubbles: true,
      })
    );
  }

  function setDescription(element, value) {
    if (!element) return;

    setNativeValue(element, value);
    emit(element, "input");
    emit(element, "change");
    emit(element, "blur");
  }

  /*
   * ============================================================
   * CLOCKIFY — PREENCHIMENTO DOS HORÁRIOS
   * ============================================================
   *
   * O Clockify espera o horário sem ":" durante o processamento
   * do evento "change".
   *
   * Sequência correta:
   *
   *   0845
   *    ↓
   *   input
   *    ↓
   *   change
   *    ↓
   *   Clockify calcula 08:45 → 12:00
   *    ↓
   *   blur
   *    ↓
   *   Clockify formata visualmente para 08:45
   *
   * IMPORTANTE:
   * Não inverter "change" e "blur".
   *
   * Contributors:
   * - Joyce Santos
   * - Nmap02
   */

  async function setTimeField(element, rawValue) {
    if (!element) return;

    const value = String(rawValue || "").replace(":", "");

    // Define o valor no formato esperado pelo Clockify.
    setNativeValue(element, value);

    // Executa o comportamento de timeOnlyNumbers(this).
    emit(element, "input");

    await sleep(50);

    // IMPORTANTE:
    // O onchange nativo do Clockify será executado aqui.
    //
    // Para o campo inicial:
    // updateDurationWhenTimeRangeChanged(this, true)
    //
    // Para o campo final:
    // updateDurationWhenTimeRangeChanged(this, false)
    //
    // O próprio HTML do Clockify decide o parâmetro correto.
    emit(element, "change");

    await sleep(100);

    // Só depois do cálculo o Clockify deve formatar:
    // 0845 -> 08:45
    emit(element, "blur");

    await sleep(100);
  }

  function parseYmd(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      String(value || "")
    );

    assert(match, "Use datas no formato AAAA-MM-DD.");

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);

    const date = new Date(year, month, day);

    assert(
      date.getFullYear() === year &&
        date.getMonth() === month &&
        date.getDate() === day,
      "Uma das datas informadas não é válida."
    );

    return date;
  }

  function toYmd(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function todayYmd() {
    return toYmd(new Date());
  }

  function getPickerFormat(dateInput) {
    const jq = getJQuery();

    try {
      return (
        jq?.(dateInput)?.datepicker("option", "dateFormat") ||
        "dd/mm/yy"
      );
    } catch (_) {
      return "dd/mm/yy";
    }
  }

  function formatDateForPicker(date, pickerFormat) {
    const tokens = {
      dd: String(date.getDate()).padStart(2, "0"),
      d: String(date.getDate()),
      mm: String(date.getMonth() + 1).padStart(2, "0"),
      m: String(date.getMonth() + 1),
      yy: String(date.getFullYear()),
      y: String(date.getFullYear()).slice(-2),
    };

    return pickerFormat.replace(
      /dd|d|mm|m|yy|y/g,
      (token) => tokens[token]
    );
  }

  function setDate(dateInput, date, pickerFormat) {
    if (!dateInput) return;

    const jq = getJQuery();
    const formatted = formatDateForPicker(date, pickerFormat);

    try {
      if (
        jq &&
        typeof jq.fn?.datepicker === "function"
      ) {
        jq(dateInput).datepicker("setDate", date);
      }
    } catch (_) {}

    setNativeValue(dateInput, formatted);
    emit(dateInput, "input");
    emit(dateInput, "change");
    emit(dateInput, "blur");
  }

  function optionsOf(select) {
    if (!select) return [];

    return Array.from(select.options || []).filter(
      (option) =>
        String(option.textContent || "").trim()
    );
  }

  function findOption(select, label) {
    if (!select) return null;

    const wanted = normalizeText(label);

    return optionsOf(select).find(
      (option) =>
        normalizeText(option.textContent) === wanted ||
        normalizeText(option.value) === wanted
    ) || null;
  }

  function setSelectValue(select, value) {
    if (!select) return;

    const jq = getJQuery();

    select.value = value;

    if (jq) {
      jq(select)
        .val(value)
        .trigger("change.select2")
        .trigger("change");
    } else {
      emit(select, "change");
    }
  }

  function setMultiSelectValue(select, values) {
    if (!select) return;

    const jq = getJQuery();

    values.forEach((val) => {
      let opt = findOption(select, val);

      if (!opt) {
        opt = new Option(val, val, true, true);
        select.append(opt);
      } else {
        opt.selected = true;
      }
    });

    if (jq) {
      jq(select)
        .trigger("change.select2")
        .trigger("change")
        .trigger("input");
    } else {
      emit(select, "change");
      emit(select, "input");
    }
  }

  function businessDays(startDate, endDate) {
    const current = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate()
    );

    const dates = [];

    while (current <= endDate) {
      const weekday = current.getDay();

      if (weekday !== 0 && weekday !== 6) {
        dates.push(new Date(current));
      }

      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  function snapshotState(elements) {
    return {
      description: elements.description
        ? elements.description.value
        : "",

      date: elements.dateInput
        ? elements.dateInput.value
        : "",

      start: elements.startInput
        ? elements.startInput.value
        : "",

      end: elements.endInput
        ? elements.endInput.value
        : "",

      task: elements.taskSelect
        ? elements.taskSelect.value
        : "",

      tags: elements.tagSelect
        ? Array.from(
            elements.tagSelect.selectedOptions || []
          ).map((o) => o.value)
        : [],
    };
  }

  function restoreState(elements, snapshot) {
    if (elements.description) {
      setDescription(
        elements.description,
        snapshot.description
      );
    }

    if (elements.dateInput) {
      setNativeValue(
        elements.dateInput,
        snapshot.date
      );
    }

    if (elements.startInput) {
      setTimeField(
        elements.startInput,
        snapshot.start
      );
    }

    if (elements.endInput) {
      setTimeField(
        elements.endInput,
        snapshot.end
      );
    }

    if (
      elements.taskSelect &&
      snapshot.task
    ) {
      setSelectValue(
        elements.taskSelect,
        snapshot.task
      );
    }

    if (elements.tagSelect) {
      setMultiSelectValue(
        elements.tagSelect,
        snapshot.tags
      );
    }
  }

  function buildResultRow(
    date,
    shiftLabel,
    timeRange,
    status,
    error
  ) {
    return {
      data: toYmd(date),
      dia: WEEKDAYS_PT_BR[date.getDay()],
      turno: shiftLabel,
      horario: timeRange,
      status,
      erro: error || "",
    };
  }

  function showStatus(message, kind = "info") {
    const output = document.querySelector(
      `#${UI_ID} [data-role="status"]`
    );

    if (!output) return;

    output.className = `cjb-status cjb-${kind}`;
    output.textContent = message;
  }

  function showSummary(
    rows,
    mode,
    config,
    totalDays
  ) {
    const successful = rows.filter(
      (row) => row.status === "ok"
    ).length;

    const failures =
      rows.length - successful;

    const action =
      mode === "add"
        ? "adicionados"
        : "validados";

    showStatus(
      `${successful} apontamento(s) ${action} (${totalDays} dia(s) × 2 turnos); ${failures} falha(s). Tag: ${config.tagName || "Sem tag"}.`,
      failures
        ? "warning"
        : "success"
    );

    console.table(rows);
  }

  async function fillOneShift(context) {
    const {
      elements,
      date,
      pickerFormat,
      startTime,
      endTime,
      config,
      description,
    } = context;

    if (elements.description) {
      setDescription(
        elements.description,
        description
      );
    }

    if (elements.dateInput) {
      setDate(
        elements.dateInput,
        date,
        pickerFormat
      );
    }

    // Preencher início.
    // O Clockify processa:
    // input -> change -> blur
    if (elements.startInput) {
      await setTimeField(
        elements.startInput,
        startTime
      );
    }

    await sleep(150);

    // Preencher fim.
    if (elements.endInput) {
      await setTimeField(
        elements.endInput,
        endTime
      );
    }

    await sleep(150);

    if (
      elements.tagSelect &&
      config.tagName
    ) {
      setMultiSelectValue(
        elements.tagSelect,
        [config.tagName]
      );
    }
  }

  async function submitCurrentEntry(elements) {
    if (!elements.addButton) return;

    const previousMessage =
      elements.messageBox
        ? elements.messageBox.innerText.trim()
        : "";

    elements.addButton.click();

    const expiresAt =
      Date.now() + 15000;

    while (
      Date.now() < expiresAt
    ) {
      await sleep(200);

      const currentText =
        elements.messageBox
          ? elements.messageBox.innerText.trim()
          : "";

      if (
        currentText &&
        currentText !== previousMessage
      ) {
        break;
      }
    }
  }

  async function run(mode) {
    assert(
      !isRunning,
      "Já existe uma execução em andamento."
    );

    isRunning = true;

    try {
      const panel =
        document.getElementById(UI_ID);

      const formValues = {
        startDate:
          panel.querySelector(
            '[name="startDate"]'
          ).value,

        endDate:
          panel.querySelector(
            '[name="endDate"]'
          ).value,

        morningStart:
          panel.querySelector(
            '[name="morningStart"]'
          ).value,

        morningEnd:
          panel.querySelector(
            '[name="morningEnd"]'
          ).value,

        afternoonStart:
          panel.querySelector(
            '[name="afternoonStart"]'
          ).value,

        afternoonEnd:
          panel.querySelector(
            '[name="afternoonEnd"]'
          ).value,
      };

      const startDate =
        parseYmd(
          formValues.startDate
        );

      const endDate =
        parseYmd(
          formValues.endDate
        );

      assert(
        startDate <= endDate,
        "A data inicial deve ser anterior ou igual à data final."
      );

      const config = saveConfig({
        morningStart:
          formValues.morningStart,

        morningEnd:
          formValues.morningEnd,

        afternoonStart:
          formValues.afternoonStart,

        afternoonEnd:
          formValues.afternoonEnd,
      });

      if (mode === "add") {
        const accepted =
          window.confirm(
            `Confirmar inclusão de apontamentos por dia em 2 turnos:\n• Manhã: ${config.morningStart} às ${config.morningEnd}\n• Tarde: ${config.afternoonStart} às ${config.afternoonEnd}\n${
              config.tagName
                ? 'Tag: “' +
                  config.tagName +
                  '”\n'
                : ""
            }\nEsta ação adicionará horas no Clockify.`
          );

        if (!accepted) {
          showStatus(
            "Inclusão cancelada. Nenhum apontamento foi adicionado.",
            "info"
          );

          isRunning = false;
          return;
        }
      }

      showStatus(
        "Preenchendo apontamentos por turno...",
        "info"
      );

      const elements =
        getElements();

      assert(
        elements.dateInput &&
          elements.startInput &&
          elements.endInput,
        "Os campos do Clockify não estão totalmente visíveis na aba Manual."
      );

      const pickerFormat =
        getPickerFormat(
          elements.dateInput
        );

      const description =
        (
          config.descriptionOverride ||
          ""
        ).trim() ||
        (
          elements.description
            ? elements.description.value
            : ""
        ) ||
        "Apontamento Jira";

      const dates =
        businessDays(
          startDate,
          endDate
        );

      assert(
        dates.length,
        "O intervalo informado não contém dias úteis."
      );

      const snapshot =
        snapshotState(
          elements
        );

      const rows = [];

      for (const date of dates) {

        // ======================================================
        // 1. TURNO MANHÃ
        // ======================================================

        try {
          await fillOneShift({
            elements,
            date,
            pickerFormat,
            startTime:
              config.morningStart,
            endTime:
              config.morningEnd,
            config,
            description,
          });

          if (mode === "add") {
            await submitCurrentEntry(
              elements
            );
          }

          rows.push(
            buildResultRow(
              date,
              "Manhã",
              `${config.morningStart} - ${config.morningEnd}`,
              "ok"
            )
          );

          // Delay configurável no topo do script.
          if (DELAY_MS > 0) {
            await sleep(
              DELAY_MS
            );
          }

        } catch (error) {
          rows.push(
            buildResultRow(
              date,
              "Manhã",
              `${config.morningStart} - ${config.morningEnd}`,
              "erro",
              error.message
            )
          );
        }

        // ======================================================
        // 2. TURNO TARDE
        // ======================================================

        try {
          await fillOneShift({
            elements,
            date,
            pickerFormat,
            startTime:
              config.afternoonStart,
            endTime:
              config.afternoonEnd,
            config,
            description,
          });

          if (mode === "add") {
            await submitCurrentEntry(
              elements
            );
          }

          rows.push(
            buildResultRow(
              date,
              "Tarde",
              `${config.afternoonStart} - ${config.afternoonEnd}`,
              "ok"
            )
          );

          // Delay configurável no topo do script.
          if (DELAY_MS > 0) {
            await sleep(
              DELAY_MS
            );
          }

        } catch (error) {
          rows.push(
            buildResultRow(
              date,
              "Tarde",
              `${config.afternoonStart} - ${config.afternoonEnd}`,
              "erro",
              error.message
            )
          );
        }
      }

      if (mode === "dry-run") {
        restoreState(
          elements,
          snapshot
        );
      }

      showSummary(
        rows,
        mode,
        config,
        dates.length
      );

    } catch (error) {
      showStatus(
        error.message ||
          "Falha na execução.",
        "error"
      );

    } finally {
      isRunning = false;
    }
  }

  function configureModal() {
    const current =
      getConfig();

    const tagNamePrompt =
      window.prompt(
        "Digite o nome da tag do Clockify para este navegador (ou deixe em branco para nenhuma):",
        current.tagName || ""
      );

    if (
      tagNamePrompt !== null
    ) {
      saveConfig({
        tagName:
          tagNamePrompt.trim(),
      });

      const saved =
        getConfig();

      showStatus(
        saved.tagName
          ? `Tag “${saved.tagName}” salva neste navegador.`
          : "Nenhuma tag configurada.",
        "success"
      );

      renderConfigHint();
    }
  }

  function renderConfigHint() {
    const hint =
      document.querySelector(
        `#${UI_ID} [data-role="configHint"]`
      );

    if (!hint) return;

    const config =
      getConfig();

    hint.textContent =
      config.tagName
        ? `Tag ativa neste navegador: ${config.tagName}`
        : "Nenhuma tag configurada (clique em Configurações para definir).";
  }

  function injectStyles() {
    if (
      document.getElementById(
        `${UI_ID}-style`
      )
    ) {
      return;
    }

    const style =
      document.createElement(
        "style"
      );

    style.id =
      `${UI_ID}-style`;

    style.textContent = `
      #${UI_ID}{
        margin:10px 0;
        padding:12px;
        background:#f4f5f7;
        border:1px solid #dfe1e6;
        border-radius:6px;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
        color:#172b4d
      }

      #${UI_ID} *{
        box-sizing:border-box
      }

      #${UI_ID} .cjb-header{
        display:flex;
        align-items:center;
        justify-content:space-between
      }

      #${UI_ID} .cjb-toggle{
      border:1px solid #0052cc;
      border-radius:4px;
      background:#0052cc;
      color:#fff;
      padding:12px 12px;
      font-size:12px;
      font-weight:600;
      cursor:pointer;
      flex: 1;
      }

      #${UI_ID} .cjb-toggle:hover{
        background:#0065ff
      }

      #${UI_ID} .cjb-hint{
        font-size:11px;
        color:#42526e;
        margin:6px 0
      }

      #${UI_ID} .cjb-container{
        display:flex;
        flex-direction:column;
        gap:8px;
        margin:8px 0
      }

      #${UI_ID} .cjb-section-header{
        font-size:11px;
        font-weight:700;
        color:#0052cc;
        text-transform:uppercase;
        letter-spacing:0.4px;
        margin-top:4px
      }

      #${UI_ID} .cjb-row{
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:8px
      }

      #${UI_ID} .cjb-row.cjb-full{
        grid-template-columns:1fr
      }

      #${UI_ID} label{
        display:flex;
        flex-direction:column;
        gap:3px;
        font-size:11px;
        font-weight:700;
        color:#172b4d
      }

      #${UI_ID} input{
        border:1px solid #7a869a;
        border-radius:4px;
        padding:6px;
        background:#fff;
        color:#172b4d;
        font-size:12px;
        width:100%
      }

      #${UI_ID} input:focus{
        border-color:#4c9aff;
        outline:none;
        box-shadow:0 0 0 2px #deebff
      }

      #${UI_ID} .cjb-time-format{
        font-size:11px;
        color:#5e6c84;
        margin:0;
        font-weight:600
      }

      #${UI_ID} .cjb-actions{
        display:flex;
        gap:6px;
        margin-top:10px
      }

      #${UI_ID} button{
        border:0;
        border-radius:4px;
        padding:6px 12px;
        background:#dfe1e6;
        color:#172b4d;
        font-weight:700;
        font-size:11px;
        cursor:pointer
      }

      #${UI_ID} button.cjb-primary{
        background:#0052cc;
        color:#fff
      }

      #${UI_ID} .cjb-status{
        border-radius:4px;
        padding:6px 8px;
        margin-top:8px;
        font-size:11px;
        white-space:pre-wrap
      }

      #${UI_ID} .cjb-info{
        background:#deebff;
        color:#0747a6
      }

      #${UI_ID} .cjb-success{
        background:#e3fcef;
        color:#006644
      }

      #${UI_ID} .cjb-warning{
        background:#fffae6;
        color:#7f5f01
      }

      #${UI_ID} .cjb-error{
        background:#ffebe6;
        color:#bf2600
      }
      #${UI_ID} input[type="time"] {
      appearance: auto;
      -moz-appearance: auto;
      }

      #${UI_ID} input[type="time"]::-webkit-calendar-picker-indicator {
      display: block;
      opacity: 1;
      cursor: pointer;
      }
    `;

    document.head.appendChild(
      style
    );
  }

  function mountInsideClockify() {
    const isClockify =
      Boolean(
        document.querySelector(
          SELECTORS.root
        ) ||
          document.querySelector(
            SELECTORS.tag
          ) ||
          document.querySelector(
            SELECTORS.date
          ) ||
          location.hostname.includes(
            "clockify.me"
          )
      );

    if (!isClockify) return;

    if (
      document.getElementById(
        UI_ID
      )
    ) {
      return;
    }

    const targetContainer =
      document.querySelector(
        "#stopwatch-manual"
      ) ||
      document.querySelector(
        "#stopwatch"
      ) ||
      document.body;

    if (!targetContainer) return;

    injectStyles();

    const config =
      getConfig();

    const panel =
      document.createElement(
        "div"
      );

    panel.id =
      UI_ID;

    panel.innerHTML = `
      <div class="cjb-header">
        <button
          class="cjb-toggle"
          type="button"
          data-role="toggle"
        >
          🕛 CHECKPOINT - SYSTEM 🕛
        </button>
      </div>

      <div
        class="cjb-body"
        style="display:none;margin-top:10px;"
      >
        <p
          data-role="configHint"
          class="cjb-hint"
        ></p>

        <div class="cjb-container">

          <div class="cjb-row">
            <label>
              Data inicial
              <input
                type="date"
                name="startDate"
                value="${todayYmd()}"
                required
              >
            </label>

            <label>
              Data final
              <input
                type="date"
                name="endDate"
                value="${todayYmd()}"
                required
              >
            </label>
          </div>

          <div class="cjb-section-header">
            🌅 Turno Manhã
          </div>

          <div class="cjb-row">
            <label>
              Início
              <input
                type="time"
                name="morningStart"
                value="${config.morningStart}"
                required
              >
            </label>

            <label>
              Fim
              <input
                type="time"
                name="morningEnd"
                value="${config.morningEnd}"
                required
              >
            </label>
          </div>

          <div class="cjb-section-header">
            🌇 Turno Tarde
          </div>

          <div class="cjb-row">
            <label>
              Início
              <input
                type="time"
                name="afternoonStart"
                value="${config.afternoonStart}"
                required
              >
            </label>

            <label>
              Fim
              <input
                type="time"
                name="afternoonEnd"
                value="${config.afternoonEnd}"
                required
              >
            </label>
          </div>

          <p class="cjb-time-format">
            Formato: 24h
          </p>

        </div>

        <p
          style="
            font-size:11px;
            color:#5e6c84;
            margin:6px 0 2px;
          "
        >
          “Validar” testa o preenchimento dos campos.</br>
          “Adicionar” incluirá os apontamentos no Clockify.
        </p>

        <div class="cjb-actions">

          <button
            type="button"
            data-role="config"
          >
            Configurações
          </button>

          <button
            type="button"
            data-role="dryRun"
          >
            Validar
          </button>

          <button
            type="button"
            class="cjb-primary"
            data-role="add"
          >
            Adicionar
          </button>

        </div>

        <div
          class="cjb-status cjb-info"
          data-role="status"
        >
          Pronto para preencher no Clockify.
        </div>

      </div>
    `;

    targetContainer.prepend(
      panel
    );

    const toggleBtn =
      panel.querySelector(
        '[data-role="toggle"]'
      );

    const bodyEl =
      panel.querySelector(
        ".cjb-body"
      );

    toggleBtn.addEventListener(
      "click",
      () => {
        bodyEl.style.display =
          bodyEl.style.display ===
          "none"
            ? "block"
            : "none";
      }
    );

    panel
      .querySelector(
        '[data-role="config"]'
      )
      .addEventListener(
        "click",
        () => configureModal()
      );

    panel
      .querySelector(
        '[data-role="dryRun"]'
      )
      .addEventListener(
        "click",
        () => run("dry-run")
      );

    panel
      .querySelector(
        '[data-role="add"]'
      )
      .addEventListener(
        "click",
        () => run("add")
      );

    renderConfigHint();
  }

  function boot() {
    mountInsideClockify();

    const observer =
      new MutationObserver(
        mountInsideClockify
      );

    observer.observe(
      document.documentElement,
      {
        childList: true,
        subtree: true,
      }
    );
  }

  boot();

})();
