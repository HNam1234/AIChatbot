import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";
import {
  bestMatchParsedUnitToPdfSpan,
  bestMatchPdfSpanToParsedUnit,
  fallbackBlockForPdfSpan,
  normalizeTextForAlignment
} from "/textAlignment.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const form = document.querySelector("#pipeline-form");
const fileInput = document.querySelector("#pdf");
const selectedFilesEl = document.querySelector("#selected-files");
const jobStatusEl = document.querySelector("#job-status");
const currentFileEl = document.querySelector("#current-file");
const currentStepEl = document.querySelector("#current-step");
const elapsedEl = document.querySelector("#elapsed");
const progressFillEl = document.querySelector("#progress-fill");
const progressTextEl = document.querySelector("#progress-text");
const logsEl = document.querySelector("#logs");
const batchTableEl = document.querySelector("#batch-table");
const markdownEl = document.querySelector("#markdown");
const renderedEl = document.querySelector("#rendered");
const sectionsEl = document.querySelector("#sections");
const sectionDetailEl = document.querySelector("#section-detail");
const treeEl = document.querySelector("#tree");
const markersEl = document.querySelector("#markers");
const imagesEl = document.querySelector("#images");
const pdfFrame = document.querySelector("#pdf-frame");
const pageNumberInput = document.querySelector("#page-number");
const prevPageButton = document.querySelector("#prev-page");
const nextPageButton = document.querySelector("#next-page");
const openPageLink = document.querySelector("#open-page");
const askButton = document.querySelector("#ask");
const questionInput = document.querySelector("#question");
const questionAllDocsInput = document.querySelector("#question-all-docs");
const questionDocIdInput = document.querySelector("#question-doc-id");
const questionDocScopeEl = document.querySelector("#question-doc-scope");
const answerEl = document.querySelector("#answer");
const pageIndexKeyInput = document.querySelector("#pageindex-key");
const geminiKeyInputs = [...document.querySelectorAll("[data-gemini-key-input]")];
const geminiKeyEnabledInputs = [...document.querySelectorAll("[data-gemini-key-enabled]")];
const temporaryPageIndexKeyInput = document.querySelector("#temporary-pageindex-key");
const temporaryGeminiKeyInput = document.querySelector("#temporary-gemini-key");
const uploadPageIndexInput = document.querySelector("#upload-pageindex");
const reusePageIndexCacheInput = document.querySelector("#reuse-pageindex-cache");
const pageIndexSettingsStatusEl = document.querySelector("#pageindex-settings-status");
const geminiSettingsStatusEl = document.querySelector("#gemini-settings-status");
const savePageIndexKeyButton = document.querySelector("#save-pageindex-key");
const togglePageIndexKeyButton = document.querySelector("#toggle-pageindex-key");
const toggleGeminiKeyButtons = [...document.querySelectorAll("[data-toggle-gemini-key]")];
const saveGeminiKeyButtons = [...document.querySelectorAll("[data-save-gemini-key]")];
const pageIndexWarningEl = document.querySelector("#pageindex-warning");
const cacheStatusSummaryEl = document.querySelector("#cache-status-summary");
const runButton = document.querySelector("[form='pipeline-form'][type='submit']");
const reuseParsedCacheInput = document.querySelector("#reuse-parsed-cache");
const forceReparseInput = document.querySelector("#force-reparse");
const forcePageIndexUploadInput = document.querySelector("#force-pageindex-upload");
const setupScreen = document.querySelector("#setup-screen");
const chatScreen = document.querySelector("#chat-screen");
const backToSetupButton = document.querySelector("#back-to-setup");
const continueToChatButton = document.querySelector("#continue-to-chat");
const querySourceListEl = document.querySelector("#query-source-list");
const screenSubtitleEl = document.querySelector("#screen-subtitle");
const debugOutputEl = document.querySelector("#debug-output");
const chatTerminalEl = document.querySelector("#chat-terminal");
const toggleDebugPanelButton = document.querySelector("#toggle-debug-panel");
const collapseDebugPanelButton = document.querySelector("#collapse-debug-panel");
const openMappingButton = document.querySelector("#open-mapping");
const mappingScreen = document.querySelector("#mapping-screen");
const mappingDocumentSelect = document.querySelector("#mapping-document");
const mappingPageInput = document.querySelector("#mapping-page");
const mappingModeSelect = document.querySelector("#mapping-mode");
const mappingPrevPageButton = document.querySelector("#mapping-prev-page");
const mappingNextPageButton = document.querySelector("#mapping-next-page");
const mappingCacheStatusEl = document.querySelector("#mapping-cache-status");
const mappingShowTextOverlayInput = document.querySelector("#mapping-show-text-overlay");
const mappingShowOverlayInput = document.querySelector("#mapping-show-overlay");
const mappingSelectedOnlyInput = document.querySelector("#mapping-selected-only");
const mappingShowTextSpansInput = document.querySelector("#mapping-show-text-spans");
const mappingShowBlocksInput = document.querySelector("#mapping-show-blocks");
const mappingSectionOnlyInput = document.querySelector("#mapping-section-only");
const mappingShowLabelsInput = document.querySelector("#mapping-show-labels");
const mappingInvertYInput = document.querySelector("#mapping-invert-y");
const mappingTypeFilterSelect = document.querySelector("#mapping-type-filter");
const mappingPageCountEl = document.querySelector("#mapping-page-count");
const mappingPdfStage = document.querySelector("#mapping-pdf-stage");
const mappingCanvas = document.querySelector("#mapping-canvas");
const mappingOverlay = document.querySelector("#mapping-overlay");
const mappingPdfMessageEl = document.querySelector("#mapping-pdf-message");
const mappingTextViewerEl = document.querySelector("#mapping-text-viewer");
const mappingDetailsEl = document.querySelector("#mapping-details");
const mappingClearSelectionButton = document.querySelector("#mapping-clear-selection");

let activeJobId = null;
let pollTimer = null;
let selectedDocument = null;
let selectedBundle = null;
let indexedDocuments = [];
let currentPdfUrl = "";
let currentPage = 1;
let clientLogs = [];
let selectedCacheRows = [];
let availableSources = [];
let selectedSourceKeys = new Set();
let debugPanelCollapsed = false;
let mappingDocuments = [];
let mappingData = null;
let mappingPdfDocument = null;
let mappingCurrentPage = 1;
let mappingSelectedBlockId = null;
let mappingSelectedSectionKey = null;
let mappingSelectedUnitId = null;
let mappingSelectedPdfSpanId = null;
let mappingMatchInfo = null;
let mappingAlignmentIndex = null;
let mappingViewportScale = 1;
let mappingRenderToken = 0;
let cacheStatusRequestId = 0;
let uploadInProgress = false;
let settings = {
  hasPageIndexApiKey: false,
  maskedPageIndexApiKey: null,
  hasGeminiApiKey: false,
  maskedGeminiApiKey: null,
  legacyGeminiKeyConfigured: false,
  maskedLegacyGeminiApiKey: null,
  geminiKeySlots: [],
  configuredGeminiKeyCount: 0,
  enabledGeminiKeyCount: 0
};

void loadSettings();
void loadIndexedDocuments();
void loadMappingDocuments();
showSetupScreen();

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

fileInput.addEventListener("change", () => {
  void refreshSelectedCacheStatus();
});
pageIndexKeyInput.addEventListener("input", updatePageIndexWarning);
uploadPageIndexInput.addEventListener("change", updatePageIndexWarning);
reusePageIndexCacheInput.addEventListener("change", updatePageIndexWarning);
reuseParsedCacheInput.addEventListener("change", updatePageIndexWarning);
forceReparseInput.addEventListener("change", updatePageIndexWarning);
forcePageIndexUploadInput.addEventListener("change", updatePageIndexWarning);
backToSetupButton.addEventListener("click", showSetupScreen);
continueToChatButton.addEventListener("click", () => {
  if (hasProcessedSources()) {
    showChatScreen();
  }
});
openMappingButton?.addEventListener("click", () => {
  void showMappingScreen();
});
toggleDebugPanelButton?.addEventListener("click", () => setDebugPanelCollapsed(!debugPanelCollapsed));
collapseDebugPanelButton?.addEventListener("click", () => setDebugPanelCollapsed(true));
questionAllDocsInput.addEventListener("change", updateAgentScope);
questionDocIdInput.addEventListener("input", updateAgentScope);
mappingDocumentSelect?.addEventListener("change", () => {
  if (mappingDocumentSelect.value) {
    void loadMappingDocument(mappingDocumentSelect.value);
  }
});
mappingPageInput?.addEventListener("change", () => {
  const page = Number(mappingPageInput.value) || 1;
  void renderMappingPage(page);
});
mappingPrevPageButton?.addEventListener("click", () => {
  void renderMappingPage(Math.max(1, mappingCurrentPage - 1));
});
mappingNextPageButton?.addEventListener("click", () => {
  void renderMappingPage(Math.min(mappingData?.pageCount || mappingCurrentPage + 1, mappingCurrentPage + 1));
});
mappingModeSelect?.addEventListener("change", renderMappingTextViewer);
mappingShowTextOverlayInput?.addEventListener("change", renderMappingOverlays);
mappingShowOverlayInput?.addEventListener("change", renderMappingOverlays);
mappingSelectedOnlyInput?.addEventListener("change", renderMappingOverlays);
mappingShowTextSpansInput?.addEventListener("change", renderMappingOverlays);
mappingShowBlocksInput?.addEventListener("change", renderMappingOverlays);
mappingSectionOnlyInput?.addEventListener("change", renderMappingOverlays);
mappingShowLabelsInput?.addEventListener("change", renderMappingOverlays);
mappingInvertYInput?.addEventListener("change", renderMappingOverlays);
mappingTypeFilterSelect?.addEventListener("change", () => {
  renderMappingOverlays();
  renderMappingTextViewer();
});
mappingClearSelectionButton?.addEventListener("click", () => {
  mappingSelectedBlockId = null;
  mappingSelectedSectionKey = null;
  mappingSelectedUnitId = null;
  mappingSelectedPdfSpanId = null;
  mappingMatchInfo = null;
  renderMappingOverlays();
  renderMappingTextViewer();
  renderMappingDetails();
});
prevPageButton.addEventListener("click", () => setPdfPage(Math.max(1, currentPage - 1)));
nextPageButton.addEventListener("click", () => setPdfPage(currentPage + 1));
pageNumberInput.addEventListener("change", () => setPdfPage(Number(pageNumberInput.value) || 1));

togglePageIndexKeyButton.addEventListener("click", () => togglePasswordInput(pageIndexKeyInput, togglePageIndexKeyButton));
toggleGeminiKeyButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector(`#${button.dataset.target}`);
    if (input) togglePasswordInput(input, button);
  });
});

savePageIndexKeyButton.addEventListener("click", async () => {
  const apiKey = pageIndexKeyInput.value.trim();
  if (!apiKey) {
    pageIndexSettingsStatusEl.textContent = "Enter a PageIndex API key first.";
    return;
  }
  const payload = await saveApiKey("/api/settings/pageindex-key", apiKey, pageIndexSettingsStatusEl);
  if (!payload) return;
  pageIndexKeyInput.value = "";
  settings.hasPageIndexApiKey = true;
  settings.maskedPageIndexApiKey = payload.maskedKey;
  pageIndexSettingsStatusEl.textContent = `PageIndex key configured: yes (${payload.maskedKey})`;
  updatePageIndexWarning();
});

saveGeminiKeyButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const input = document.querySelector(`#${button.dataset.target}`);
    const apiKey = input?.value.trim() || "";
    if (!apiKey) {
      geminiSettingsStatusEl.textContent = `Enter a Gemini API key for ${button.dataset.slot}.`;
      return;
    }

    const payload = await saveApiKey("/api/settings/gemini-key", apiKey, geminiSettingsStatusEl, {
      slot: button.dataset.slot
    });
    if (!payload) return;

    input.value = "";
    settings.hasGeminiApiKey = true;
    settings.maskedGeminiApiKey = payload.maskedKey;
    const slot = (settings.geminiKeySlots || []).find((candidate) => candidate.name === payload.slotName);
    if (slot) {
      slot.configured = true;
      slot.maskedKey = payload.maskedKey;
      slot.enabled = slot.enabled !== false;
    }
    settings.configuredGeminiKeyCount = (settings.geminiKeySlots || []).filter((candidate) => candidate.configured).length;
    settings.enabledGeminiKeyCount = (settings.geminiKeySlots || [])
      .filter((candidate) => candidate.configured && candidate.enabled !== false).length;
    renderGeminiSettingsStatus();
  });
});

geminiKeyEnabledInputs.forEach((input) => {
  input.addEventListener("change", async () => {
    const payload = await saveGeminiKeyEnabled(input.dataset.slot, input.checked);
    if (!payload) {
      input.checked = !input.checked;
      return;
    }

    const slot = (settings.geminiKeySlots || []).find((candidate) => candidate.name === payload.slotName);
    if (slot) {
      slot.enabled = payload.enabled;
    }
    settings.enabledGeminiKeyCount = (settings.geminiKeySlots || [])
      .filter((candidate) => candidate.configured && candidate.enabled).length;
    renderGeminiSettingsStatus();
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (uploadInProgress) return;
  setRunButtonDisabled(true);
  clearInterval(pollTimer);
  resetResult();

  const cacheRows = await ensureSelectedCacheStatus();
  const selectedFiles = [...fileInput.files];
  const body = buildPipelineFormData(selectedFiles, cacheRows);
  if (temporaryPageIndexKeyInput.checked && pageIndexKeyInput.value.trim()) {
    body.set("temporaryPageIndexApiKey", pageIndexKeyInput.value.trim());
  } else {
    body.delete("temporaryPageIndexApiKey");
  }
  if (temporaryGeminiKeyInput.checked) {
    geminiKeyInputs.forEach((input, index) => {
      const keyName = `temporaryGeminiApiKey${index + 1}`;
      if (isGeminiSlotEnabled(input.dataset.slot) && input.value.trim()) {
        body.set(keyName, input.value.trim());
      } else {
        body.delete(keyName);
      }
    });
  } else {
    body.delete("temporaryGeminiApiKey");
    body.delete("temporaryGeminiApiKey1");
    body.delete("temporaryGeminiApiKey2");
    body.delete("temporaryGeminiApiKey3");
  }

  const uploadFiles = selectedFiles.filter((file) => !cacheRowForFile(file, cacheRows)?.canReuseUploadedInput);
  const cachedFiles = selectedFiles.filter((file) => cacheRowForFile(file, cacheRows)?.canReuseUploadedInput);
  const uploadBytes = uploadFiles.reduce((sum, file) => sum + file.size, 0);
  let lastUploadLogPercent = -10;

  setTopStatus({ status: "uploading", currentStep: "uploading files", progressPercent: 0 });
  renderSelectedFiles("uploading");
  appendUiLog(traceLine("ui.formSubmit", "upload started", {
    fileCount: uploadFiles.length,
    cachedFileCount: cachedFiles.length,
    totalBytes: uploadBytes,
    files: uploadFiles.map((file) => file.name)
  }));

  let uploadResult;
  try {
    uploadResult = await uploadFormData("/api/run-pipeline", body, (percent) => {
      if (Number.isFinite(percent) && (percent >= lastUploadLogPercent + 10 || percent === 100)) {
        lastUploadLogPercent = percent;
        appendUiLog(traceLine("ui.uploadFormData", "upload progress", { percent }));
      }
      setTopStatus({
        status: "uploading",
        currentStep: `uploading files${Number.isFinite(percent) ? ` (${percent}%)` : ""}`,
        progressPercent: Number.isFinite(percent) ? percent : 0
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setRunButtonDisabled(false);
    setTopStatus({ status: "failed", currentStep: message, progressPercent: 0 });
    appendUiLog(traceLine("ui.uploadFormData", "upload interrupted", { error: message }));
    return;
  }

  const payload = uploadResult.payload;
  if (!uploadResult.ok) {
    setRunButtonDisabled(false);
    setTopStatus({ status: "failed", currentStep: payload.error || "Failed to start pipeline", progressPercent: 0 });
    appendUiLog(traceLine("ui.uploadFormData", "upload rejected", {
      status: uploadResult.status,
      error: payload.error || "Failed to start pipeline."
    }));
    return;
  }

  setTopStatus({ status: "queued", currentStep: "upload complete; parser queued", progressPercent: 100 });
  renderSelectedFiles("uploaded");
  appendUiLog(traceLine("ui.uploadFormData", "upload completed; parser queued", {
    status: uploadResult.status,
    jobId: payload.jobId
  }));
  activeJobId = payload.jobId;
  pollTimer = setInterval(pollStatus, 1500);
  await pollStatus();
});

askButton.addEventListener("click", async () => {
  const question = questionInput.value.trim();
  const manualDocIds = parseDocIds(questionDocIdInput.value);
  const checkedSources = selectedQuerySources();
  const checkedDocuments = uniqueStrings(checkedSources.map((source) => source.document).filter(Boolean));
  const checkedTreeDocuments = uniqueStrings(checkedSources.filter(sourceHasCachedTree).map((source) => source.document).filter(Boolean));
  const checkedLocalDocuments = uniqueStrings(checkedSources.filter((source) => !sourceHasCachedTree(source)).map((source) => source.document).filter(Boolean));
  const selectedTreeDocument = selectedBundle?.document && selectedBundle.hasTree ? [selectedBundle.document] : [];
  const selectedLocalDocument = selectedBundle?.document && !selectedBundle.hasTree ? [selectedBundle.document] : [];
  const selectedDocIds = !selectedBundle?.hasTree && selectedBundle?.pageIndexDocId ? [selectedBundle.pageIndexDocId] : [];
  const docIds = questionAllDocsInput.checked
    ? uniqueStrings([...manualDocIds])
    : uniqueStrings([...manualDocIds, ...selectedDocIds]);
  if (!question) {
    answerEl.className = "chat-thread warning";
    answerEl.textContent = "Enter a question first.";
    return;
  }
  const canUseSelectedCachedTree = Boolean(selectedBundle?.document && selectedBundle.hasTree);
  const canUseSelectedLocalSections = Boolean(selectedBundle?.document && Array.isArray(selectedBundle.sections) && selectedBundle.sections.length > 0);
  const canUseCheckedLocalSections = questionAllDocsInput.checked && checkedLocalDocuments.length > 0;
  if (questionAllDocsInput.checked && checkedSources.length === 0 && manualDocIds.length === 0) {
    answerEl.className = "chat-thread warning";
    answerEl.textContent = "Select at least one processed source before asking.";
    return;
  }
  if (docIds.length === 0 && !canUseCheckedLocalSections && !questionAllDocsInput.checked && !canUseSelectedCachedTree && !canUseSelectedLocalSections) {
    answerEl.className = "chat-thread warning";
    answerEl.textContent = "No source is available. Add PDFs and run the pipeline before chatting.";
    return;
  }
  const mixedCheckedSources = questionAllDocsInput.checked && checkedTreeDocuments.length > 0 && checkedLocalDocuments.length > 0;
  const cachedTreeDocuments = questionAllDocsInput.checked
    ? mixedCheckedSources
      ? []
      : checkedTreeDocuments
    : selectedTreeDocument;
  const localSectionDocuments = questionAllDocsInput.checked
    ? mixedCheckedSources
      ? checkedDocuments
      : checkedLocalDocuments
    : selectedLocalDocument;
  const selectedScope = cachedTreeDocuments.length > 0
    ? "cached-tree-selected"
    : localSectionDocuments.length > 0
      ? "local-sections"
      : docIds.length > 0
        ? "selected"
        : "local-sections";
  answerEl.className = "chat-thread muted";
  renderDebugOutput(escapeHtml("Waiting for retrieval debug..."), true);
  answerEl.textContent = selectedScope === "cached-tree-selected"
    ? `Searching cached tree JSON for ${cachedTreeDocuments.length} selected source(s)...`
    : selectedScope === "local-sections"
      ? `Searching local sections for ${localSectionDocuments.length} selected source(s)...`
    : docIds.length > 0
      ? `Asking PageIndex Chat across ${docIds.length} document(s)...`
      : `Searching local sections for ${selectedBundle.document}...`;
  const body = {
    question,
    docIds,
    scope: selectedScope,
    cachedTreeDocuments,
    document: localSectionDocuments.join(","),
    debug: true
  };
  if (temporaryPageIndexKeyInput.checked && pageIndexKeyInput.value.trim()) {
    body.temporaryPageIndexApiKey = pageIndexKeyInput.value.trim();
  }
  const geminiApiKeys = selectedGeminiKeys();
  if (geminiApiKeys.length > 0) {
    body.geminiApiKeys = geminiApiKeys;
  }
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    answerEl.className = "chat-thread warning";
    answerEl.textContent = payload.error || "Could not get answer.";
    renderDebugOutput(escapeHtml(payload.error || "Could not get retrieval debug."), true);
    return;
  }
  answerEl.className = "chat-thread";
  const indexSource = payload.indexSourceDetails || (typeof payload.indexSource === "object" ? payload.indexSource : selectedIndexSource());
  const indexSourceCode = typeof payload.indexSource === "string" ? payload.indexSource : indexSource?.source;
  const answerScope = indexSource?.source === "pageindex-chat" || indexSourceCode === "pageindex_live"
    ? `Scope: ${(payload.docIds || docIds).length} PageIndex document(s)`
    : `Index source: ${formatIndexSource(indexSource, payload.retrieval)}`;
  const retrievalStatus = renderRetrievalStatus(payload.retrieval, indexSource, payload);
  const summaryIntent = payload.intent === "chapter_summary" || payload.intent === "document_summary";
  const documentSummaryCard = summaryIntent ? renderDocumentSummaryCard(payload.documentSummary) : "";
  const citationCards = summaryIntent ? "" : renderCitationCards(payload.citations || []);
  renderDebugOutput(renderDebugPanel(payload.debug, indexSource, payload.retrieval, payload));
  answerEl.innerHTML = `
    <div class="answer-box">
      <div class="answer-text">${escapeHtml(payload.answer || "")}</div>
    </div>
    <div class="answer-metadata">
      ${retrievalStatus}
      ${documentSummaryCard}
      ${citationCards}
      <p>${escapeHtml(answerScope)}</p>
    </div>
  `;
});

questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    askButton.click();
  }
});

async function pollStatus() {
  if (!activeJobId) return;
  const response = await fetch(`/api/status/${activeJobId}`);
  const job = await response.json();
  if (!response.ok) {
    setTopStatus({ status: "failed", currentStep: job.error || "Job not found", progressPercent: 0 });
    clearInterval(pollTimer);
    return;
  }

  setTopStatus(job);
  syncTerminalLogs(job.logs || []);
  renderBatchStatus(job.files || []);

  if (job.status === "completed" || job.status === "failed") {
    clearInterval(pollTimer);
    setRunButtonDisabled(false);
    await loadResult();
  }
}

async function loadResult() {
  const response = await fetch(`/api/result/${activeJobId}`);
  const payload = await response.json();
  if (!response.ok) {
    logsEl.textContent = payload.error || "Could not load result.";
    return;
  }
  renderBatchOutputs(payload.outputs?.documentOutputs || []);
  await loadIndexedDocuments();
  await loadMappingDocuments();
  const firstDocument = payload.selectedDocument || payload.outputs?.selectedDocument;
  if (firstDocument) {
    await loadDocument(firstDocument);
  }
  if (hasProcessedSources()) {
    showChatScreen();
  }
}

async function loadDocument(documentName) {
  selectedDocument = documentName;
  const response = await fetch(`/api/result/${activeJobId}/document/${encodeURIComponent(documentName)}`);
  const bundle = await response.json();
  if (!response.ok) return;
  renderDocument(bundle);
}

function renderDocument(bundle) {
  selectedBundle = bundle;
  updateAgentScope(bundle);
  currentPdfUrl = bundle.uploadUrl || `/api/uploads/${encodeURIComponent(bundle.document)}`;
  setPdfPage(1);
  markdownEl.classList.remove("muted");
  markdownEl.textContent = bundle.markdown || bundle.markdownPreview || "";
  renderedEl.classList.remove("muted");
  renderedEl.innerHTML = renderMarkdown(bundle.markdown || bundle.markdownPreview || "");
  renderSections(bundle.sections || [], bundle.document);
  renderTree(bundle.tree);
  renderMarkers(bundle);
  renderImages(bundle.images || []);
}

function setTopStatus(job) {
  const percent = Math.max(0, Math.min(100, Math.round(job.progressPercent || 0)));
  jobStatusEl.innerHTML = statusChip(job.status || "Idle");
  currentFileEl.textContent = job.currentFile || "n/a";
  currentStepEl.textContent = job.currentStep || "n/a";
  elapsedEl.textContent = formatElapsed(job.elapsedMs || 0);
  progressFillEl.style.width = `${percent}%`;
  progressTextEl.textContent = `${percent}% - ${job.currentFile ? `Processing ${job.currentFile} - ` : ""}${job.currentStep || "waiting"}`;
}

function renderSelectedFiles(status = "waiting") {
  const files = [...fileInput.files];
  if (files.length === 0) {
    selectedFilesEl.className = "selected-files muted";
    selectedFilesEl.textContent = "No files selected.";
    return;
  }
  selectedFilesEl.className = "selected-files";
  const hasCacheRows = selectedCacheRows.length > 0 && selectedCacheRows.some((row) => row.parseCacheStatus);
  if (!hasCacheRows) {
    selectedFilesEl.innerHTML = files.map((file) => `
      <div class="file-row">
        <span>${escapeHtml(file.name)}</span>
        <span>${formatBytes(file.size)}</span>
        ${statusChip(status)}
      </div>
    `).join("");
    return;
  }

  selectedFilesEl.innerHTML = batchTableMarkup(files.map((file) => {
    const row = cacheRowForFile(file, selectedCacheRows) || {};
    return {
      document: row.document || file.name,
      progressPercent: status === "uploaded" ? 100 : status === "uploading" ? 30 : 0,
      parseCache: row.parseCacheStatus || "checking",
      pageIndexCache: row.pageIndexCacheStatus || "checking",
      assets: Number.isFinite(row.assets) ? row.assets : "",
      sections: Number.isFinite(row.sections) ? row.sections : "",
      tree: row.treeStatus || "checking",
      action: plannedAction(row, status),
      error: row.error || ""
    };
  }), true);
}

function renderBatchStatus(files) {
  if (files.length === 0) return;
  batchTableEl.classList.remove("muted");
  batchTableEl.innerHTML = batchTableMarkup(files.map((file) => ({
    document: file.filename,
    status: file.status,
    progressPercent: file.progressPercent,
    parseCache: file.outputs?.parseCacheStatus || file.status,
    pageIndexCache: file.outputs?.pageIndexCacheStatus || "",
    assets: file.outputs?.imageCount ?? "",
    sections: file.outputs?.hsSectionCount ?? "",
    tree: file.outputs?.treeStatus || "",
    action: file.currentStep || "",
    error: file.error || ""
  })), true);
}

function renderBatchOutputs(outputs) {
  if (outputs.length === 0) return;
  mergeAvailableSources(outputs.map((output) => ({
    document: output.document,
    docId: output.pageIndexDocId,
    treePath: output.paths?.tree || "",
    pageIndexCacheStatus: output.pageIndexCacheStatus || output.pageIndexCacheStatusAfter || output.pageIndex || "skipped",
    parseCacheStatus: output.parseCacheStatus || output.parseCacheStatusAfter || output.status,
    treeStatus: output.treeStatus || (output.hasTree ? "cached" : "missing"),
    sectionCount: output.hsSections ?? output.hsSectionCount ?? 0
  })));
  mergeIndexedDocuments(outputs
    .filter((output) => output.pageIndexDocId)
    .map((output) => ({
      document: output.document,
      docId: output.pageIndexDocId,
      treePath: output.paths?.tree || ""
    })));
  batchTableEl.classList.remove("muted");
  batchTableEl.innerHTML = batchTableMarkup(outputs.map((output) => ({
    document: output.document,
    status: output.status,
    progressPercent: 100,
    parseCache: output.parseCacheStatus || output.parseCacheStatusAfter || output.status,
    pageIndexCache: output.pageIndexCacheStatus || output.pageIndexCacheStatusAfter || output.pageIndex || "skipped",
    assets: output.imagesExported ?? output.imageCount ?? 0,
    sections: output.hsSections ?? output.hsSectionCount ?? 0,
    tree: output.treeStatus || (output.hasTree ? "cached" : "missing"),
    action: renderOutputAction(output),
    error: output.error || ""
  })), false);

  batchTableEl.querySelectorAll("[data-document]").forEach((row) => {
    row.addEventListener("click", () => loadDocument(row.dataset.document));
  });
}

function batchTableMarkup(rows, live) {
  return `
    <div class="source-list ${live ? "live" : ""}">
      ${rows.map((row) => `
        <article data-document="${escapeHtml(row.document)}" class="source-card ${selectedDocument === row.document ? "selected" : ""}">
          <div class="source-title">
            <strong>${escapeHtml(row.document)}</strong>
            ${statusChip(row.status || row.parseCache || "waiting")}
          </div>
          <div class="mini-progress"><span style="width:${Number(row.progressPercent || 0)}%"></span></div>
          <div class="source-chips">
            <span class="chip-group">Parse ${statusChip(row.parseCache || row.status || "n/a")}</span>
            <span class="chip-group">Index ${statusChip(row.pageIndexCache || "n/a")}</span>
            ${row.tree ? `<span class="chip-group">Tree ${statusChip(row.tree)}</span>` : ""}
          </div>
          <div class="source-meta">
            <span>Assets ${escapeHtml(row.assets ?? "")}</span>
            <span>Sections ${escapeHtml(row.sections ?? "")}</span>
          </div>
          ${row.action ? `<div class="source-action">${escapeHtml(row.action)}</div>` : ""}
          ${row.error ? `<div class="error-cell">${escapeHtml(row.error)}</div>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderSections(sections, documentName) {
  if (sections.length === 0) {
    sectionsEl.className = "table-wrap muted";
    sectionsEl.textContent = "No sections.json found.";
    sectionDetailEl.className = "section-detail muted";
    sectionDetailEl.textContent = "No section mapping available.";
    return;
  }
  sectionsEl.className = "table-wrap";
  sectionsEl.innerHTML = `
    <table>
      <thead><tr><th>HS Code</th><th>Title</th><th>Page Range</th><th>Source</th><th>Section</th></tr></thead>
      <tbody>
        ${sections.map((section, index) => `
          <tr data-index="${index}">
            <td>${escapeHtml(section.hsCode || "")}</td>
            <td>${escapeHtml(section.title || "")}</td>
            <td>${escapeHtml(pageRange(section))}</td>
            <td>${escapeHtml(section.source || "")}</td>
            <td>${escapeHtml(section.section || section.chapter || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  sectionsEl.querySelectorAll("tr[data-index]").forEach((row) => {
    row.addEventListener("click", () => {
      const section = sections[Number(row.dataset.index)];
      sectionsEl.querySelectorAll("tr").forEach((candidate) => candidate.classList.remove("selected"));
      row.classList.add("selected");
      renderSectionDetail(section, documentName);
    });
  });
}

function renderSectionDetail(section, documentName) {
  const page = Number(section.pageStart);
  if (Number.isFinite(page) && page > 0) {
    setPdfPage(page);
  }
  sectionDetailEl.className = "section-detail";
  sectionDetailEl.innerHTML = `
    <strong>${escapeHtml(section.hsCode || "")} - ${escapeHtml(section.title || "")}</strong>
    <div>Document: ${escapeHtml(section.document || documentName)}</div>
    <div>Page: ${escapeHtml(pageRange(section))}</div>
    <div>Source: ${escapeHtml(section.source || "n/a")}</div>
    <p>${escapeHtml(section.textPreview || "")}</p>
    ${Number.isFinite(page) ? `<a href="${currentPdfUrl}#page=${page}" target="_blank" rel="noreferrer">Open PDF at page: ${page}</a>` : ""}
  `;
}

function renderTree(treeJson) {
  const roots = treeJson?.tree || treeJson?.rawResponse?.structure || [];
  if (!Array.isArray(roots) || roots.length === 0) {
    treeEl.className = "tree muted";
    treeEl.textContent = "No tree JSON found.";
    return;
  }
  treeEl.className = "tree";
  treeEl.innerHTML = renderTreeNodes(roots);
}

function renderTreeNodes(nodes) {
  return `<ul>${nodes.map((node) => `
    <li>
      <details open>
        <summary>${escapeHtml(node.title || "Untitled")} <span>${escapeHtml(node.node_id || "")}</span></summary>
        ${node.summary ? `<p>${escapeHtml(node.summary)}</p>` : ""}
        ${Array.isArray(node.nodes) && node.nodes.length > 0 ? renderTreeNodes(node.nodes) : ""}
      </details>
    </li>
  `).join("")}</ul>`;
}

function renderMarkers(outputs) {
  const markers = [
    ...(outputs.validation?.markers || outputs.validationJson?.markers || []),
    ...(outputs.treeValidation?.markers || outputs.treeValidationJson?.markers || [])
  ];
  if (markers.length === 0) {
    markersEl.className = "markers muted";
    markersEl.textContent = "No validation markers yet.";
    return;
  }
  markersEl.className = "markers";
  markersEl.innerHTML = markers.map((marker) => `
    <div class="marker ${marker.passed ? "pass" : "fail"}">
      <strong>${escapeHtml(marker.marker)}</strong>
      <span>${marker.passed ? "passed" : "failed"}</span>
      <p>${escapeHtml(marker.message || "")}</p>
      ${marker.details ? `<pre>${escapeHtml(JSON.stringify(marker.details, null, 2))}</pre>` : ""}
    </div>
  `).join("");
}

function renderImages(images) {
  if (images.length === 0) {
    imagesEl.className = "images muted";
    imagesEl.textContent = "No exported images.";
    return;
  }
  imagesEl.className = "images";
  imagesEl.innerHTML = images.map((image) => `
    <figure>
      <img src="${image.url}" alt="${escapeHtml(image.name)}" loading="lazy" />
      <figcaption>
        <strong>${escapeHtml(image.imageId || image.name)}</strong>
        <span>${escapeHtml(image.path || "")}</span>
        <span>${image.pageNumber ? `Page ${image.pageNumber}` : ""}</span>
      </figcaption>
    </figure>
  `).join("");
}

function renderCitationCards(citations) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return "";
  }

  return `<div class="citation-cards">${citations.map((citation, index) => `
    <div class="citation-card">
      <strong>${index === 0 ? "Product citation" : "Scoped related match"}</strong>
      <dl>
        <dt>HS Code</dt><dd>${escapeHtml(citation.hsCode || "n/a")}</dd>
        <dt>Grouped</dt><dd>${escapeHtml(Array.isArray(citation.groupedHsCodes) && citation.groupedHsCodes.length > 0 ? citation.groupedHsCodes.join(", ") : "n/a")}</dd>
        <dt>Title</dt><dd>${escapeHtml(citation.title || "n/a")}</dd>
        <dt>Document</dt><dd>${escapeHtml(citation.document || "n/a")}</dd>
        <dt>Page</dt><dd>${escapeHtml(formatCitationPage(citation.pageStart, citation.pageEnd))}</dd>
        <dt>Section</dt><dd>${escapeHtml(citation.section || "n/a")}</dd>
        <dt>Source</dt><dd>${escapeHtml(citation.source || "n/a")}</dd>
      </dl>
    </div>
  `).join("")}</div>`;
}

function renderDocumentSummaryCard(summary) {
  if (!summary) {
    return "";
  }

  const sections = Array.isArray(summary.sections) ? summary.sections : [];
  const title = summary.type === "chapter_summary"
    ? `Chapter ${summary.chapterNumber || "n/a"} summary`
    : "Document summary";
  return `
    <div class="citation-cards">
      <div class="citation-card">
        <strong>${escapeHtml(title)}</strong>
        <dl>
          <dt>Document</dt><dd>${escapeHtml(summary.document || "n/a")}</dd>
          <dt>Sections</dt><dd>${escapeHtml(String(summary.sectionCount ?? sections.length ?? 0))}</dd>
          ${summary.isReference !== undefined ? `<dt>Reference</dt><dd>${summary.isReference ? "yes" : "no"}</dd>` : ""}
        </dl>
        ${sections.length > 0 ? `
          <ul>
            ${sections.slice(0, 8).map((section) => `
              <li>${escapeHtml(section.title || "Untitled")} ${Array.isArray(section.codes) && section.codes.length > 0 ? `- ${escapeHtml(section.codes.join(", "))}` : ""}</li>
            `).join("")}
          </ul>
        ` : ""}
      </div>
    </div>
  `;
}

function renderRetrievalStatus(retrieval, indexSource, payload = {}) {
  if (!retrieval && !indexSource) {
    return "";
  }

  const fallback = Boolean(retrieval?.bm25FallbackUsed || indexSource?.source === "bm25-fallback" || indexSource?.source === "local-sections");
  const codes = Array.isArray(retrieval?.finalHsCodes) ? retrieval.finalHsCodes.join(", ") : "";
  const sourceLabel = formatIndexSource(indexSource, retrieval);
  const documentDetails = renderIndexSourceDocuments(indexSource);
  return `
    <div class="retrieval-status ${fallback ? "warning" : ""}">
      <strong>Index source: ${escapeHtml(sourceLabel)}</strong>
      ${fallback ? "<span>BM25/local fallback used</span>" : "<span>PageIndex tree result used</span>"}
      ${codes ? `<span>Final HS Code(s): ${escapeHtml(codes)}</span>` : ""}
      ${retrieval?.answerRepairApplied ? "<span>Answer repair applied</span>" : ""}
      ${payload.indexSource ? `<span>Index source code: ${escapeHtml(payload.indexSource)}</span>` : ""}
      ${payload.pageIndexUploadStatus ? `<span>PageIndex upload/cache status: ${escapeHtml(payload.pageIndexUploadStatus)}</span>` : ""}
      ${payload.cacheFreshness?.stale?.length ? `<span>Warning: stale cached tree used for ${escapeHtml(payload.cacheFreshness.stale.join(", "))}</span>` : ""}
      ${payload.pageIndexUploadStatus === "skipped" && payload.cachedDocumentCount > 0 ? "<span>Warning: upload skipped, using available cached tree.</span>" : ""}
      ${indexSource?.warning ? `<span>${escapeHtml(indexSource.warning)}</span>` : ""}
      ${documentDetails}
    </div>
  `;
}

function renderDebugPanel(debug, indexSource, retrieval, payload = {}) {
  if (!debug) {
    return renderDebugSummary(indexSource, retrieval);
  }

  const selected = debug.selectedPrimary && Object.keys(debug.selectedPrimary).length > 0
    ? renderDebugSelected(debug.selectedPrimary)
    : "";
  const candidates = Array.isArray(debug.candidates) ? debug.candidates : [];
  const intentLine = debug.detectedIntent
    ? `<span>Intent: ${escapeHtml(debug.detectedIntent)} (${escapeHtml(debug.intentReason || "")})</span>`
    : "";
  const documentLine = debug.resolvedDocument
    ? `<dt>Resolved document</dt><dd><pre>${escapeHtml(JSON.stringify(debug.resolvedDocument, null, 2))}</pre></dd>`
    : "";
  return `
    <details class="debug-panel" open>
      <summary>Q&A debug</summary>
      ${intentLine}
      ${selected}
      <dl>
        ${documentLine}
        <dt>Index source</dt><dd>${escapeHtml(payload.indexSource || indexSource?.source || "unknown")}</dd>
        <dt>Scope</dt><dd><pre>${escapeHtml(JSON.stringify(payload.scope || debug.scope || {}, null, 2))}</pre></dd>
        <dt>Cache freshness</dt><dd><pre>${escapeHtml(JSON.stringify(payload.cacheFreshness || {}, null, 2))}</pre></dd>
        <dt>Answer generation</dt><dd>${escapeHtml(payload.answerGeneration || debug.answerGeneration || "unknown")}</dd>
        <dt>Signals</dt><dd><pre>${escapeHtml(JSON.stringify(debug.extractedSignals || {}, null, 2))}</pre></dd>
        <dt>Retrieval</dt><dd><pre>${escapeHtml(JSON.stringify(debug.retrieval || {}, null, 2))}</pre></dd>
      </dl>
      <div class="debug-candidates">
        ${candidates.slice(0, 8).map(renderDebugCandidate).join("")}
      </div>
    </details>
  `;
}

function renderDebugSummary(indexSource, retrieval) {
  return `
    <div class="debug-summary">
      <strong>Debug payload is empty</strong>
      <span>Index source: ${escapeHtml(formatIndexSource(indexSource, retrieval))}</span>
      ${retrieval?.source ? `<span>Retrieval source: ${escapeHtml(retrieval.source)}</span>` : ""}
      ${retrieval?.bm25FallbackUsed ? "<span>BM25/local fallback used</span>" : ""}
    </div>
  `;
}

function renderDebugOutput(content, muted = false) {
  if (!debugOutputEl) return;
  debugOutputEl.className = muted ? "debug-output muted" : "debug-output";
  debugOutputEl.innerHTML = content || "No retrieval debug yet.";
}

function renderDebugSelected(selected) {
  return `
    <div class="citation-card debug-selected">
      <strong>Selected section</strong>
      <dl>
        <dt>HS Code</dt><dd>${escapeHtml(selected.hsCode || groupedCodesText(selected.groupedHsCodes) || "n/a")}</dd>
        <dt>Title</dt><dd>${escapeHtml(selected.title || "n/a")}</dd>
        <dt>Document</dt><dd>${escapeHtml(selected.document || "n/a")}</dd>
        <dt>Page</dt><dd>${escapeHtml(formatCitationPage(selected.pageStart, selected.pageEnd))}</dd>
        <dt>Section</dt><dd>${escapeHtml(selected.section || "n/a")}</dd>
        <dt>Source</dt><dd>${escapeHtml(selected.source || "n/a")}</dd>
      </dl>
    </div>
  `;
}

function renderDebugCandidate(candidate) {
  const status = candidate.rejected ? `Rejected: ${candidate.rejectedReason || "relevance gate"}` : "Accepted";
  return `
    <div class="debug-candidate ${candidate.rejected ? "rejected" : ""}">
      <strong>${escapeHtml(candidate.hsCode || groupedCodesText(candidate.groupedHsCodes) || "no HS metadata")} - ${escapeHtml(candidate.title || candidate.section || "unknown")}</strong>
      <span>${escapeHtml(status)}</span>
      <span>Final score: ${escapeHtml(String(Math.round((candidate.finalScore ?? candidate.relevanceScore ?? 0) * 100) / 100))}</span>
      <span>Matched tokens: ${escapeHtml((candidate.candidateMatchedTokens || candidate.matchedTerms || []).join(", ") || "none")}</span>
      <span>Matched phrases: ${escapeHtml((candidate.candidateMatchedPhrases || []).join(", ") || "none")}</span>
      <span>Numeric: ${escapeHtml((candidate.numericMatches || candidate.matchedNumericRanges || []).join(", ") || "none")}</span>
      <span>Contrast: ${escapeHtml((candidate.contrastTerms || []).join(", ") || "none")}</span>
    </div>
  `;
}

function groupedCodesText(codes) {
  return Array.isArray(codes) && codes.length > 0 ? codes.join(", ") : "";
}

function formatCitationPage(pageStart, pageEnd) {
  if (pageStart && pageEnd && pageStart !== pageEnd) {
    return `${pageStart}-${pageEnd}`;
  }
  return pageStart || pageEnd || "n/a";
}

function setPdfPage(page) {
  currentPage = Math.max(1, page);
  pageNumberInput.value = String(currentPage);
  if (!currentPdfUrl) return;
  const url = `${currentPdfUrl}#page=${currentPage}`;
  pdfFrame.src = url;
  openPageLink.href = url;
}

function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  document.querySelector(`#tab-${tabName}`)?.classList.remove("hidden");
}

function resetResult() {
  logsEl.textContent = "";
  if (chatTerminalEl) chatTerminalEl.textContent = "No runtime logs yet.";
  clientLogs = [];
  answerEl.className = "chat-thread muted";
  answerEl.textContent = "Ask a question about the selected document, all cached trees, or local sections.";
  renderDebugOutput(escapeHtml("Ask a question, then inspect retrieval candidates here."), true);
  markdownEl.textContent = "No Markdown yet.";
  markdownEl.className = "markdown muted";
  renderedEl.textContent = "No rendered preview yet.";
  renderedEl.className = "rendered muted";
  sectionsEl.textContent = "No sections yet.";
  sectionsEl.className = "table-wrap muted";
  sectionDetailEl.textContent = "Select a section to inspect page mapping.";
  sectionDetailEl.className = "section-detail muted";
  treeEl.textContent = "No tree JSON yet.";
  treeEl.className = "tree muted";
  markersEl.textContent = "No markers yet.";
  markersEl.className = "markers muted";
  imagesEl.textContent = "No images yet.";
  imagesEl.className = "images muted";
  batchTableEl.textContent = "No documents yet.";
  batchTableEl.className = "table-wrap muted";
  pdfFrame.removeAttribute("src");
  currentPdfUrl = "";
  selectedDocument = null;
  selectedBundle = null;
  updateAgentScope(null);
}

async function refreshSelectedCacheStatus() {
  const requestId = ++cacheStatusRequestId;
  const files = [...fileInput.files];
  selectedCacheRows = [];
  if (files.length === 0) {
    renderSelectedFiles();
    updatePageIndexWarning();
    return [];
  }

  renderSelectedFiles("checking cache");
  try {
    const records = [];
    for (const file of files) {
      records.push({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        inputHash: await hashFile(file)
      });
    }
    if (requestId !== cacheStatusRequestId) {
      return selectedCacheRows;
    }
    const response = await fetch("/api/cache-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: records })
    });
    const payload = await response.json();
    if (!response.ok) {
      selectedCacheRows = records.map((record) => ({
        document: record.name,
        originalName: record.name,
        inputHash: record.inputHash,
        parseCacheStatus: "missing",
        pageIndexCacheStatus: "missing",
        treeStatus: "missing",
        error: payload.error || "Could not inspect cache."
      }));
    } else {
      selectedCacheRows = payload.documents || [];
    }
  } catch (error) {
    selectedCacheRows = files.map((file) => ({
      document: file.name,
      originalName: file.name,
      parseCacheStatus: "missing",
      pageIndexCacheStatus: "missing",
      treeStatus: "missing",
      error: error instanceof Error ? error.message : String(error)
    }));
  }
  renderSelectedFiles();
  updatePageIndexWarning();
  return selectedCacheRows;
}

async function ensureSelectedCacheStatus() {
  const files = [...fileInput.files];
  if (files.length === 0) {
    return [];
  }
  const hasAllRows = files.every((file) => cacheRowForFile(file, selectedCacheRows));
  return hasAllRows ? selectedCacheRows : await refreshSelectedCacheStatus();
}

function buildPipelineFormData(files, cacheRows) {
  const body = new FormData();
  const ocrLanguage = form.elements.ocrLanguage?.value?.trim() || "vie+eng";
  body.set("ocrLanguage", ocrLanguage);
  body.set("doclingThreads", form.elements.doclingThreads?.value || "4");
  appendChecked(body, "exportAssets", form.elements.exportAssets);
  appendChecked(body, "reuseParsedCache", reuseParsedCacheInput);
  appendChecked(body, "reuseCachedPageIndexTree", reusePageIndexCacheInput);
  appendChecked(body, "forceReparse", forceReparseInput);
  appendChecked(body, "uploadPageIndex", uploadPageIndexInput);
  appendChecked(body, "forcePageIndexUpload", forcePageIndexUploadInput);
  appendChecked(body, "failFast", form.elements.failFast);

  const cachedFiles = [];
  for (const file of files) {
    const row = cacheRowForFile(file, cacheRows);
    if (row?.canReuseUploadedInput) {
      cachedFiles.push({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        inputHash: row.inputHash
      });
    } else {
      body.append("files", file, file.name);
    }
  }
  if (cachedFiles.length > 0) {
    body.set("cachedFiles", JSON.stringify(cachedFiles));
  }
  return body;
}

function appendChecked(body, name, input) {
  if (input?.checked) {
    body.set(name, "true");
  }
}

function cacheRowForFile(file, rows) {
  return rows.find((row) => row.originalName === file.name || row.document === file.name);
}

function plannedAction(row, status = "waiting") {
  if (status === "uploading") return row.canReuseUploadedInput ? "using cached PDF" : "uploading PDF";
  if (status === "uploaded") return "queued";
  if (!row || !row.parseCacheStatus) return status;
  const parseAction = forceReparseInput.checked
    ? "parse: force"
    : reuseParsedCacheInput.checked && row.parseCacheStatus === "fresh"
      ? "parse: skip cache"
      : "parse: run";
  let pageIndexAction = "PageIndex: disabled";
  if (uploadPageIndexInput.checked) {
    pageIndexAction = forcePageIndexUploadInput.checked
      ? "PageIndex: force upload"
      : reusePageIndexCacheInput.checked && row.pageIndexCacheStatus === "fresh"
        ? "PageIndex: reuse tree"
        : "PageIndex: upload if needed";
  }
  return `${parseAction}; ${pageIndexAction}`;
}

function renderOutputAction(output) {
  const parts = [];
  if (output.parseAction) parts.push(`parse: ${output.parseAction}`);
  if (output.pageIndexAction) parts.push(`PageIndex: ${output.pageIndexAction}`);
  return parts.join("; ") || output.pageIndex || output.status || "";
}

function selectedIndexSource() {
  if (!selectedBundle) {
    return { label: "Local sections only", source: "local-sections" };
  }
  const status = selectedBundle.pageIndexCacheStatus || selectedBundle.pageIndexStatus;
  if (status === "fresh") {
    return {
      label: selectedBundle.pageIndexDocId ? "Fresh PageIndex tree" : "Cached PageIndex tree",
      source: "cached-pageindex-tree",
      cachedDocumentCount: 1,
      cacheStatus: "fresh",
      documents: [{ document: selectedBundle.document, status: "fresh" }]
    };
  }
  if (selectedBundle.hasTree) {
    return {
      label: "Stale cached PageIndex tree",
      source: "cached-pageindex-tree",
      cachedDocumentCount: 1,
      cacheStatus: "stale",
      warning: "Cached tree may be stale; re-upload PageIndex to sync with latest Markdown.",
      documents: [{ document: selectedBundle.document, status: status || "stale" }]
    };
  }
  return {
    label: selectedBundle.sections?.length ? "Local sections only" : "BM25 fallback",
    source: selectedBundle.sections?.length ? "local-sections" : "bm25-fallback",
    cachedDocumentCount: 0,
    documents: selectedBundle.document ? [{ document: selectedBundle.document, status: "local-sections" }] : []
  };
}

function formatIndexSource(indexSource, retrieval) {
  if (indexSource?.label) {
    const count = Number(indexSource.cachedDocumentCount);
    const status = indexSource.cacheStatus ? `, ${indexSource.cacheStatus}` : "";
    return Number.isFinite(count) && count > 0
      ? `${indexSource.label} (${count} documents${status})`
      : indexSource.label;
  }
  if (retrieval?.source === "bm25-fallback") return "BM25 fallback";
  if (retrieval?.source === "local-sections") return "Local sections only";
  return retrieval?.source || "unknown";
}

function renderIndexSourceDocuments(indexSource) {
  if (!Array.isArray(indexSource?.documents) || indexSource.documents.length === 0) {
    return "";
  }
  const details = indexSource.documents
    .slice(0, 12)
    .map((document) => `${document.document || document.docId}: ${document.status}`)
    .join(" | ");
  return `<span>${escapeHtml(details)}</span>`;
}

function setRunButtonDisabled(disabled) {
  uploadInProgress = disabled;
  if (runButton) {
    runButton.disabled = disabled;
    runButton.textContent = disabled ? "Running..." : "Run Pipeline";
  }
}

async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function showSetupScreen() {
  setupScreen?.classList.remove("hidden");
  chatScreen?.classList.add("hidden");
  mappingScreen?.classList.add("hidden");
  backToSetupButton?.classList.add("hidden");
  runButton?.classList.remove("hidden");
  continueToChatButton?.classList.remove("hidden");
  openMappingButton?.classList.remove("hidden");
  if (screenSubtitleEl) screenSubtitleEl.textContent = "Add PDFs, configure keys, then process sources before chatting.";
  updateChatGate();
}

function showChatScreen() {
  if (!hasProcessedSources()) {
    showSetupScreen();
    return;
  }
  setupScreen?.classList.add("hidden");
  chatScreen?.classList.remove("hidden");
  mappingScreen?.classList.add("hidden");
  backToSetupButton?.classList.remove("hidden");
  runButton?.classList.add("hidden");
  continueToChatButton?.classList.add("hidden");
  openMappingButton?.classList.remove("hidden");
  if (screenSubtitleEl) screenSubtitleEl.textContent = "Ask across selected parsed sources. Use the back arrow to edit the dataset.";
  renderQuerySourceList();
  updateAgentScope();
}

async function showMappingScreen() {
  setupScreen?.classList.add("hidden");
  chatScreen?.classList.add("hidden");
  mappingScreen?.classList.remove("hidden");
  backToSetupButton?.classList.remove("hidden");
  runButton?.classList.add("hidden");
  continueToChatButton?.classList.add("hidden");
  openMappingButton?.classList.add("hidden");
  if (screenSubtitleEl) screenSubtitleEl.textContent = "Map PDF page regions to parsed blocks and sections.";
  await loadMappingDocuments();
  const selected = mappingDocumentSelect?.value || mappingDocuments[0]?.document;
  if (selected && (!mappingData || mappingData.document !== selected)) {
    await loadMappingDocument(selected);
  }
}

function setDebugPanelCollapsed(collapsed) {
  debugPanelCollapsed = collapsed;
  chatScreen?.classList.toggle("debug-collapsed", collapsed);
  if (toggleDebugPanelButton) {
    toggleDebugPanelButton.textContent = collapsed ? "Show terminal" : "Hide terminal";
  }
  if (collapseDebugPanelButton) {
    collapseDebugPanelButton.textContent = collapsed ? "Collapsed" : "Collapse";
  }
}

function hasProcessedSources() {
  return availableSources.length > 0 || indexedDocuments.length > 0;
}

function updateChatGate() {
  const ready = hasProcessedSources();
  if (continueToChatButton) {
    continueToChatButton.disabled = !ready;
    continueToChatButton.textContent = ready ? "Continue to chat" : "Process data first";
  }
  if (askButton) {
    askButton.disabled = !ready;
  }
  if (openMappingButton) {
    openMappingButton.disabled = mappingDocuments.length === 0;
  }
  renderQuerySourceList();
}

function mergeAvailableSources(sources) {
  const byKey = new Map(availableSources.map((source) => [sourceKey(source), source]));
  for (const source of sources) {
    if (!source?.document) continue;
    const normalized = {
      document: source.document,
      docId: source.docId || null,
      treePath: source.treePath || "",
      pageIndexCacheStatus: source.pageIndexCacheStatus || "missing",
      parseCacheStatus: source.parseCacheStatus || "fresh",
      treeStatus: source.treeStatus || (source.treePath ? "cached" : "missing"),
      sectionCount: Number(source.sectionCount || source.hsSectionCount || source.sections || 0)
    };
    const key = sourceKey(normalized);
    byKey.set(key, { ...(byKey.get(key) || {}), ...normalized });
    if (!selectedSourceKeys.has(key)) {
      selectedSourceKeys.add(key);
    }
  }
  availableSources = [...byKey.values()]
    .sort((left, right) => String(left.document).localeCompare(String(right.document)));
  renderQuerySourceList();
  updateChatGate();
}

function sourceKey(source) {
  return source.docId ? `doc:${source.docId}` : `local:${source.document}`;
}

function sourceHasCachedTree(source) {
  const status = String(source?.pageIndexCacheStatus || source?.treeStatus || "").toLowerCase();
  return Boolean(source?.treePath || source?.docId || ["fresh", "cached", "stale"].includes(status));
}

function selectedQuerySources() {
  return availableSources.filter((source) => selectedSourceKeys.has(sourceKey(source)));
}

function renderQuerySourceList() {
  if (!querySourceListEl) return;
  if (availableSources.length === 0) {
    querySourceListEl.className = "query-source-list muted";
    querySourceListEl.textContent = "No processed sources yet.";
    return;
  }

  querySourceListEl.className = "query-source-list";
  querySourceListEl.innerHTML = availableSources.map((source) => {
    const key = sourceKey(source);
    const selected = selectedSourceKeys.has(key);
    return `
      <label class="query-source-card ${selected ? "selected" : ""}" data-source-key="${escapeHtml(key)}">
        <input type="checkbox" data-source-checkbox="${escapeHtml(key)}" ${selected ? "checked" : ""} />
        <span>
          <strong>${escapeHtml(source.document)}</strong>
          <small>${escapeHtml(source.docId ? "PageIndex tree" : "Local sections")} · ${escapeHtml(source.sectionCount || 0)} sections</small>
        </span>
        ${statusChip(source.pageIndexCacheStatus || source.treeStatus || "local")}
      </label>
    `;
  }).join("");

  querySourceListEl.querySelectorAll("[data-source-checkbox]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.sourceCheckbox;
      if (input.checked) {
        selectedSourceKeys.add(key);
      } else {
        selectedSourceKeys.delete(key);
      }
      renderQuerySourceList();
      updateAgentScope();
    });
  });
}

function updateAgentScope(bundle) {
  if (Array.isArray(bundle)) {
    indexedDocuments = bundle;
  }

  const manualDocIds = parseDocIds(questionDocIdInput.value);
  if (questionAllDocsInput.checked) {
    const selectedSources = selectedQuerySources();
    const docIdCount = uniqueStrings([...selectedSources.map((document) => document.docId).filter(Boolean), ...manualDocIds]).length;
    const localCount = selectedSources.filter((source) => !source.docId).length;
    questionDocScopeEl.textContent = selectedSources.length > 0
      ? `Scope: ${selectedSources.length} checked source(s); PageIndex doc_id values: ${docIdCount}; local section sources: ${localCount}.`
      : "Select one or more processed sources before asking.";
    return;
  }

  const selectedDocId = selectedBundle?.pageIndexDocId;
  if (manualDocIds.length > 0) {
    questionDocScopeEl.textContent = `Scope: manual doc_id list (${manualDocIds.length}).`;
    return;
  }

  if (selectedDocId) {
    questionDocScopeEl.textContent = `Scope: selected document ${selectedBundle.document} (${selectedDocId}). Index source: ${selectedIndexSource().label}.`;
    return;
  }

  if (selectedBundle?.document) {
    const source = selectedBundle.hasTree
      ? selectedIndexSource().label
      : selectedBundle.sections?.length
        ? "Local sections only"
        : "No cached index";
    questionDocScopeEl.textContent = `Selected: ${selectedBundle.document}. Index source: ${source}.`;
    return;
  }

  questionDocScopeEl.textContent = "Scope: selected document only, but no document is selected.";
}

async function loadMappingDocuments() {
  if (!mappingDocumentSelect) return;
  const response = await fetch("/api/mapping");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    mappingDocuments = [];
    mappingDocumentSelect.innerHTML = "";
    setMappingStatus(payload.error || "Could not load mapping documents.", true);
    updateChatGate();
    return;
  }

  mappingDocuments = payload.documents || [];
  mappingDocumentSelect.innerHTML = mappingDocuments.length > 0
    ? mappingDocuments.map((document) => `<option value="${escapeHtml(document.document)}">${escapeHtml(document.document)}</option>`).join("")
    : "<option value=\"\">No mapped documents</option>";
  if (mappingData?.document) {
    mappingDocumentSelect.value = mappingData.document;
  }
  setMappingStatus(
    mappingDocuments.length > 0
      ? `${mappingDocuments.length} document(s) with PDF, Markdown, and blocks.json available.`
      : "Mapping unavailable: run local parse to produce PDF, Markdown, and blocks.json.",
    mappingDocuments.length === 0
  );
  updateChatGate();
}

async function loadMappingDocument(documentName) {
  if (!documentName) return;
  setMappingStatus(`Loading mapping data for ${documentName}...`);
  mappingData = null;
  mappingPdfDocument = null;
  mappingSelectedBlockId = null;
  mappingSelectedSectionKey = null;
  mappingSelectedUnitId = null;
  mappingSelectedPdfSpanId = null;
  mappingMatchInfo = null;
  mappingAlignmentIndex = null;
  renderMappingDetails();
  if (mappingTextViewerEl) {
    mappingTextViewerEl.className = "mapping-text-viewer muted";
    mappingTextViewerEl.textContent = "Loading parsed blocks...";
  }

  const response = await fetch(`/api/mapping/${encodeURIComponent(documentName)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    setMappingStatus(payload.error || "Could not load mapping data.", true);
    if (mappingPdfMessageEl) mappingPdfMessageEl.textContent = payload.error || "Mapping unavailable.";
    return;
  }

  mappingData = payload;
  mappingAlignmentIndex = buildAlignmentIndex(payload);
  if (mappingDocumentSelect) mappingDocumentSelect.value = payload.document;
  setMappingStatus(formatMappingCacheStatus(payload));
  renderMappingTextViewer();

  try {
    mappingPdfDocument = await pdfjsLib.getDocument(payload.pdfUrl).promise;
    mappingData.pageCount = mappingPdfDocument.numPages || mappingData.pageCount || 1;
    const firstSectionPage = (payload.sections || []).find((section) => Number(section.pageStart) > 0)?.pageStart;
    await renderMappingPage(Number(firstSectionPage) || 1);
  } catch (error) {
    setMappingStatus(`Mapping unavailable: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function renderMappingPage(pageNumber) {
  if (!mappingPdfDocument || !mappingCanvas || !mappingOverlay || !mappingPdfStage) return;
  const pageCount = mappingData?.pageCount || mappingPdfDocument.numPages || 1;
  mappingCurrentPage = Math.max(1, Math.min(pageCount, Number(pageNumber) || 1));
  if (mappingPageInput) {
    mappingPageInput.max = String(pageCount);
    mappingPageInput.value = String(mappingCurrentPage);
  }
  if (mappingPageCountEl) {
    mappingPageCountEl.textContent = `Page ${mappingCurrentPage} / ${pageCount}`;
  }
  if (mappingPdfMessageEl) {
    mappingPdfMessageEl.textContent = "Rendering PDF page...";
  }

  const token = ++mappingRenderToken;
  const page = await mappingPdfDocument.getPage(mappingCurrentPage);
  const baseViewport = page.getViewport({ scale: 1 });
  const stageWidth = Math.max(320, mappingPdfStage.clientWidth - 24);
  const scale = Math.max(0.65, Math.min(2.2, stageWidth / baseViewport.width));
  mappingViewportScale = scale;
  const viewport = page.getViewport({ scale });
  const context = mappingCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  mappingCanvas.width = Math.floor(viewport.width * dpr);
  mappingCanvas.height = Math.floor(viewport.height * dpr);
  mappingCanvas.style.width = `${viewport.width}px`;
  mappingCanvas.style.height = `${viewport.height}px`;
  mappingOverlay.style.width = `${viewport.width}px`;
  mappingOverlay.style.height = `${viewport.height}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  await page.render({ canvasContext: context, viewport }).promise;
  if (token !== mappingRenderToken) return;

  await loadMappingPageTextSpans(page, viewport);
  if (token !== mappingRenderToken) return;
  renderMappingOverlays();
  if (mappingPdfMessageEl) {
    const count = currentMappingPageBlocks().length;
    const spanCount = currentMappingPageTextSpans().length;
    mappingPdfMessageEl.textContent = `${spanCount} PDF text span(s), ${count} parsed block overlay(s) on this page.`;
  }
}

function renderMappingOverlays() {
  if (!mappingOverlay || !mappingCanvas) return;
  mappingOverlay.innerHTML = "";
  const showText = mappingShowTextOverlayInput?.checked !== false;
  const showBlocks = mappingShowOverlayInput?.checked !== false;
  mappingOverlay.classList.toggle("hidden", !showText && !showBlocks);
  if (!mappingData || (!showText && !showBlocks)) return;

  if (showBlocks) {
    renderMappingBlockOverlays();
  }
  if (showText) {
    renderMappingTextSpanOverlays();
  }
}

function renderMappingBlockOverlays() {
  const blocks = currentMappingPageBlocks()
    .filter(mappingBlockVisible)
    .filter((block) => {
      if (mappingSelectedOnlyInput?.checked && block.id !== mappingSelectedBlockId && sectionKey(block) !== mappingSelectedSectionKey) {
        return false;
      }
      if (!mappingShowBlocksInput?.checked && block.id !== mappingSelectedBlockId && sectionKey(block) !== mappingSelectedSectionKey) {
        return false;
      }
      return true;
    })
    .sort((left, right) => blockArea(right) - blockArea(left));
  for (const block of blocks) {
    const rect = bboxToCanvasRect(block.bbox);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mapping-box ${block.type} ${block.id === mappingSelectedBlockId ? "selected" : ""} ${block.section && sectionKey(block) === mappingSelectedSectionKey ? "section-selected" : ""}`;
    button.dataset.blockId = block.id;
    button.style.left = `${rect.left}px`;
    button.style.top = `${rect.top}px`;
    button.style.width = `${Math.max(4, rect.width)}px`;
    button.style.height = `${Math.max(4, rect.height)}px`;
    button.title = `${block.type}: ${textPreview(block.text, 110)}`;
    if (mappingShowLabelsInput?.checked) {
      button.textContent = block.hsCode || block.type;
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void selectMappingBlock(block.id, { scrollText: true });
    });
    mappingOverlay.appendChild(button);
  }
}

function renderMappingTextSpanOverlays() {
  const spans = currentMappingPageTextSpans()
    .filter((span) => {
      if (mappingSelectedOnlyInput?.checked && span.id !== mappingSelectedPdfSpanId && span.blockId !== mappingSelectedBlockId) {
        return false;
      }
      return true;
    });
  for (const span of spans) {
    const button = document.createElement("button");
    button.type = "button";
    const selected = span.id === mappingSelectedPdfSpanId;
    const visible = selected || mappingShowTextSpansInput?.checked || mappingShowLabelsInput?.checked;
    button.className = `mapping-text-span ${selected ? "selected" : ""} ${visible ? "visible" : ""}`;
    button.dataset.pdfSpanId = span.id;
    button.style.left = `${span.bbox.x0}px`;
    button.style.top = `${span.bbox.y0}px`;
    button.style.width = `${Math.max(2, span.bbox.x1 - span.bbox.x0)}px`;
    button.style.height = `${Math.max(2, span.bbox.y1 - span.bbox.y0)}px`;
    button.title = `PDF text: ${textPreview(span.text, 120)}`;
    if (mappingShowLabelsInput?.checked) {
      button.textContent = span.index;
    }
    button.addEventListener("mouseenter", () => previewParsedUnitForSpan(span));
    button.addEventListener("mouseleave", clearMappingPreview);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void selectPdfTextSpan(span);
    });
    mappingOverlay.appendChild(button);
  }
}

async function loadMappingPageTextSpans(page, viewport) {
  if (!mappingAlignmentIndex) return;
  const pageIndex = ensureAlignmentPage(mappingCurrentPage);
  if (pageIndex.pdfTextSpansLoaded) return;
  try {
    const content = await page.getTextContent();
    pageIndex.pdfTextSpans = (content.items || [])
      .map((item, index) => pdfTextItemToSpan(item, index, mappingCurrentPage, viewport))
      .filter(Boolean)
      .map((span) => ({
        ...span,
        blockId: nearestBlockForSpan(span)?.id
      }));
    pageIndex.pdfTextSpansLoaded = true;
  } catch (error) {
    pageIndex.pdfTextSpans = [];
    pageIndex.pdfTextSpansLoaded = true;
    if (mappingPdfMessageEl) {
      mappingPdfMessageEl.textContent = `PDF text layer unavailable; using block fallback. ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function pdfTextItemToSpan(item, index, pageNumber, viewport) {
  const text = String(item?.str || "").trim();
  if (!text) return null;
  const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
  const tx = pdfjsLib.Util.transform(viewport.transform, transform);
  const height = Math.max(3, Math.hypot(tx[2], tx[3]) || Math.abs(item.height * mappingViewportScale) || 8);
  const width = Math.max(3, Math.abs((Number(item.width) || text.length * 4) * mappingViewportScale));
  const left = tx[4];
  const top = tx[5] - height;
  return {
    id: `pdf-p${pageNumber}-t${index}`,
    index,
    pageNumber,
    text,
    normalizedText: normalizeTextForAlignment(text),
    bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
    transform,
    fontName: item.fontName || "",
    dir: item.dir || ""
  };
}

function buildAlignmentIndex(payload) {
  const pages = {};
  const index = {
    document: payload.document,
    parsedTextUnits: buildParsedTextUnits(payload),
    pages
  };
  for (const block of payload.blocks || []) {
    const page = ensureAlignmentPage(Number(block.pageNumber) || 1, index);
    page.blockUnits.push({ ...block, normalizedText: normalizeTextForAlignment(block.text || block.markdownText || "") });
  }
  for (const unit of index.parsedTextUnits) {
    const pageNumber = Number(unit.pageNumber) || 0;
    if (pageNumber > 0) {
      ensureAlignmentPage(pageNumber, index).parsedTextUnits.push(unit);
    }
  }
  return index;
}

function ensureAlignmentPage(pageNumber, index = mappingAlignmentIndex) {
  if (!index.pages[pageNumber]) {
    index.pages[pageNumber] = {
      pdfTextSpans: [],
      pdfTextSpansLoaded: false,
      parsedTextUnits: [],
      blockUnits: []
    };
  }
  return index.pages[pageNumber];
}

function buildParsedTextUnits(payload) {
  const units = [];
  for (const block of payload.blocks || []) {
    const pieces = splitParsedText(block.text || block.markdownText || "");
    pieces.forEach((text, index) => {
      units.push({
        id: `${block.id}-u${index}`,
        document: payload.document,
        pageNumber: block.pageNumber,
        section: block.section,
        hsCode: block.hsCode,
        title: block.title,
        blockId: block.id,
        blockType: block.type,
        text,
        normalizedText: normalizeTextForAlignment(text),
        markdownAnchor: block.section ? markdownAnchorForText(block.section) : undefined,
        source: "block"
      });
    });
  }
  (payload.sections || []).forEach((section, sectionIndex) => {
    const lines = splitParsedText([section.title, section.textPreview].filter(Boolean).join("\n"));
    lines.forEach((text, lineIndex) => {
      units.push({
        id: `section-${sectionIndex}-u${lineIndex}`,
        document: payload.document,
        pageNumber: Number(section.pageStart) || undefined,
        section: section.section,
        hsCode: section.hsCode,
        title: section.title,
        text,
        normalizedText: normalizeTextForAlignment(text),
        markdownAnchor: markdownAnchorForText(section.markdownHeading || section.title || section.section || section.hsCode),
        source: "section"
      });
    });
  });
  splitMarkdownUnits(payload.markdown || "", payload.document).forEach((unit) => units.push(unit));
  return units.filter((unit) => unit.normalizedText);
}

function splitParsedText(text) {
  const cleaned = String(text || "").replace(/\r/g, "\n").trim();
  if (!cleaned) return [];
  const lines = cleaned
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const source = lines.length > 1 ? lines : [cleaned];
  return source.flatMap((line) => {
    if (line.length <= 180) return [line];
    return line
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/g)
      .map((piece) => piece.trim())
      .filter(Boolean);
  });
}

function splitMarkdownUnits(markdown, documentName) {
  const units = [];
  let currentHeading = "";
  String(markdown || "")
    .split(/\n{2,}/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part, index) => {
      const heading = /^(#{1,6})\s+(.+)$/m.exec(part);
      if (heading) {
        currentHeading = heading[2].trim();
      }
      const text = part.replace(/^#{1,6}\s+/gm, "").trim();
      if (!text) return;
      units.push({
        id: `markdown-u${index}`,
        document: documentName,
        section: currentHeading,
        title: heading ? heading[2].trim() : currentHeading,
        text,
        normalizedText: normalizeTextForAlignment(text),
        markdownAnchor: markdownAnchorForText(heading ? heading[2] : currentHeading),
        source: "markdown"
      });
    });
  return units;
}

async function selectPdfTextSpan(span, options = {}) {
  if (!span) return;
  mappingSelectedPdfSpanId = span.id;
  const pageIndex = ensureAlignmentPage(span.pageNumber);
  const units = candidateParsedUnitsForSpan(span);
  const match = bestMatchPdfSpanToParsedUnit(span, units, {
    currentPage: span.pageNumber,
    blocks: canvasAlignmentBlocks(span.pageNumber),
    threshold: 32
  });
  if (match.item) {
    mappingMatchInfo = match;
    await selectParsedTextUnit(match.item.id, {
      scrollPdf: false,
      scrollText: options.scrollText !== false,
      preserveMode: false,
      matchedPdfSpanId: span.id
    });
    return;
  }

  const fallback = fallbackBlockForPdfSpan(span, canvasAlignmentBlocks(span.pageNumber));
  if (fallback.item) {
    mappingMatchInfo = fallback;
    await selectMappingBlock(fallback.item.id, { scrollText: true, scrollPdf: false, confidence: "fallback" });
    return;
  }

  mappingMatchInfo = { score: match.score, confidence: "none", reasons: ["no-parsed-text-match"] };
  renderMappingOverlays();
  renderMappingTextViewer();
  renderMappingDetails();
}

async function selectParsedTextUnit(unitId, options = {}) {
  const unit = mappingAlignmentIndex?.parsedTextUnits.find((candidate) => candidate.id === unitId);
  if (!unit) return;
  mappingSelectedUnitId = unit.id;
  mappingSelectedBlockId = unit.blockId || null;
  mappingSelectedSectionKey = unit.section || unit.hsCode || unit.title || null;
  if (options.matchedPdfSpanId) {
    mappingSelectedPdfSpanId = options.matchedPdfSpanId;
  }
  const targetPage = Number(unit.pageNumber) || Number(blockForUnit(unit)?.pageNumber) || mappingCurrentPage;
  if (targetPage && targetPage !== mappingCurrentPage) {
    await renderMappingPage(targetPage);
  }
  if (!options.matchedPdfSpanId) {
    const pageIndex = ensureAlignmentPage(mappingCurrentPage);
    const match = bestMatchParsedUnitToPdfSpan(unit, pageIndex.pdfTextSpans, {
      currentPage: mappingCurrentPage,
      blocks: canvasAlignmentBlocks(mappingCurrentPage),
      threshold: 30
    });
    if (match.item) {
      mappingSelectedPdfSpanId = match.item.id;
      mappingMatchInfo = match;
    } else if (unit.blockId) {
      mappingMatchInfo = { score: match.score, confidence: "fallback", reasons: ["block-fallback"], item: blockForUnit(unit) };
    } else {
      mappingMatchInfo = { score: match.score, confidence: "none", reasons: ["no-pdf-text-match"] };
    }
  }
  if (options.preserveMode !== true && mappingModeSelect && mappingModeSelect.value !== "parsed-text") {
    mappingModeSelect.value = "parsed-text";
  }
  renderMappingOverlays();
  renderMappingTextViewer();
  renderMappingDetails(blockForUnit(unit), undefined, unit);
  if (options.scrollText !== false) {
    scrollMappingUnitIntoView(unit.id);
  }
  if (options.scrollPdf !== false) {
    mappingPdfStage?.scrollIntoView({ block: "nearest" });
  }
}

function candidateParsedUnitsForSpan(span) {
  const pageIndex = ensureAlignmentPage(span.pageNumber);
  const pageUnits = pageIndex.parsedTextUnits || [];
  const blockUnits = span.blockId ? pageUnits.filter((unit) => unit.blockId === span.blockId) : [];
  const units = blockUnits.length > 0 ? blockUnits : pageUnits;
  return units.length > 0 ? units : mappingAlignmentIndex?.parsedTextUnits || [];
}

function nearestBlockForSpan(span) {
  const pageIndex = ensureAlignmentPage(span.pageNumber);
  let best = null;
  let bestScore = 0;
  for (const block of pageIndex.blockUnits) {
    if (!block.bbox) continue;
    const rect = bboxToCanvasRect(block.bbox);
    const score = overlapRect(span.bbox, {
      x0: rect.left,
      y0: rect.top,
      x1: rect.left + rect.width,
      y1: rect.top + rect.height
    });
    if (score > bestScore) {
      best = block;
      bestScore = score;
    }
  }
  return bestScore > 0.05 ? best : null;
}

function overlapRect(left, right) {
  const x0 = Math.max(left.x0, right.x0);
  const y0 = Math.max(left.y0, right.y0);
  const x1 = Math.min(left.x1, right.x1);
  const y1 = Math.min(left.y1, right.y1);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = Math.max(1, (left.x1 - left.x0) * (left.y1 - left.y0));
  return intersection / area;
}

function blockForUnit(unit) {
  return unit?.blockId ? mappingData?.blocks.find((block) => block.id === unit.blockId) : undefined;
}

function currentMappingPageTextSpans() {
  return mappingAlignmentIndex?.pages?.[mappingCurrentPage]?.pdfTextSpans || [];
}

function currentMappingPageParsedUnits() {
  return mappingAlignmentIndex?.pages?.[mappingCurrentPage]?.parsedTextUnits || [];
}

function canvasAlignmentBlocks(pageNumber) {
  const pageIndex = ensureAlignmentPage(pageNumber);
  return pageIndex.blockUnits.map((block) => {
    if (pageNumber !== mappingCurrentPage || !block.bbox) return block;
    const rect = bboxToCanvasRect(block.bbox);
    return {
      ...block,
      bbox: {
        x0: rect.left,
        y0: rect.top,
        x1: rect.left + rect.width,
        y1: rect.top + rect.height
      }
    };
  });
}

function previewParsedUnitForSpan(span) {
  if (mappingModeSelect?.value !== "parsed-text") return;
  const match = bestMatchPdfSpanToParsedUnit(span, candidateParsedUnitsForSpan(span), {
    currentPage: span.pageNumber,
    blocks: canvasAlignmentBlocks(span.pageNumber),
    threshold: 42
  });
  if (match.item) {
    mappingTextViewerEl?.querySelector(`[data-unit-id="${cssEscape(match.item.id)}"]`)?.classList.add("preview");
  }
}

function previewPdfSpanForUnit(unit) {
  const match = bestMatchParsedUnitToPdfSpan(unit, currentMappingPageTextSpans(), {
    currentPage: mappingCurrentPage,
    blocks: canvasAlignmentBlocks(mappingCurrentPage),
    threshold: 42
  });
  if (match.item) {
    mappingOverlay?.querySelector(`[data-pdf-span-id="${cssEscape(match.item.id)}"]`)?.classList.add("preview");
  }
}

function clearMappingPreview() {
  mappingTextViewerEl?.querySelectorAll(".preview").forEach((element) => element.classList.remove("preview"));
  mappingOverlay?.querySelectorAll(".preview").forEach((element) => element.classList.remove("preview"));
}

function renderMappingTextViewer() {
  if (!mappingTextViewerEl) return;
  if (!mappingData) {
    mappingTextViewerEl.className = "mapping-text-viewer muted";
    mappingTextViewerEl.textContent = "No mapping data loaded.";
    return;
  }

  const mode = mappingModeSelect?.value || "blocks";
  mappingTextViewerEl.className = "mapping-text-viewer";
  if (mode === "parsed-text") {
    renderMappingParsedTextUnits();
    return;
  }
  if (mode === "markdown") {
    renderMappingMarkdown();
    return;
  }
  if (mode === "sections") {
    renderMappingSections();
    return;
  }

  const blocks = mappingData.blocks.filter(mappingBlockVisible);
  mappingTextViewerEl.innerHTML = blocks.map((block) => `
    <article class="mapping-block ${block.id === mappingSelectedBlockId ? "selected" : ""}" data-mapping-block-id="${escapeHtml(block.id)}">
      <div class="mapping-block-head">
        <strong>${escapeHtml(block.hsCode || block.type)}</strong>
        <span>p${escapeHtml(block.pageNumber)} · ${escapeHtml(block.type)}</span>
      </div>
      <p>${escapeHtml(textPreview(block.text || block.markdownText || "(empty block)", 500))}</p>
      ${block.section ? `<small>${escapeHtml(block.section)}</small>` : ""}
    </article>
  `).join("") || "<div class=\"muted\">No blocks match the current filters.</div>";
  mappingTextViewerEl.querySelectorAll("[data-mapping-block-id]").forEach((element) => {
    element.addEventListener("click", () => {
      void selectMappingBlock(element.dataset.mappingBlockId, { scrollPdf: true });
    });
  });
}

function renderMappingParsedTextUnits() {
  const pageUnits = currentMappingPageParsedUnits();
  const units = pageUnits.length > 0 ? pageUnits : mappingAlignmentIndex?.parsedTextUnits || [];
  const visibleUnits = units.filter((unit) => {
    if (mappingTypeFilterSelect?.value !== "all" && unit.blockType && unit.blockType !== mappingTypeFilterSelect.value) return false;
    if (mappingSectionOnlyInput?.checked && mappingSelectedSectionKey) {
      return unit.section === mappingSelectedSectionKey || unit.hsCode === mappingSelectedSectionKey || unit.title === mappingSelectedSectionKey;
    }
    return true;
  });
  mappingTextViewerEl.innerHTML = visibleUnits.map((unit) => `
    <article class="mapping-unit ${unit.id === mappingSelectedUnitId ? "selected" : ""}" data-unit-id="${escapeHtml(unit.id)}">
      <div class="mapping-block-head">
        <strong>${escapeHtml(unit.hsCode || unit.title || unit.blockType || unit.source)}</strong>
        <span>p${escapeHtml(unit.pageNumber || "?")} &middot; ${escapeHtml(unit.source)}${unit.blockType ? ` &middot; ${escapeHtml(unit.blockType)}` : ""}</span>
      </div>
      <p>${escapeHtml(unit.text)}</p>
      ${unit.section ? `<small>${escapeHtml(unit.section)}</small>` : ""}
    </article>
  `).join("") || "<div class=\"muted\">No parsed text units match the current filters.</div>";
  mappingTextViewerEl.querySelectorAll("[data-unit-id]").forEach((element) => {
    element.addEventListener("mouseenter", () => {
      const unit = mappingAlignmentIndex?.parsedTextUnits.find((candidate) => candidate.id === element.dataset.unitId);
      if (unit) previewPdfSpanForUnit(unit);
    });
    element.addEventListener("mouseleave", clearMappingPreview);
    element.addEventListener("click", () => {
      void selectParsedTextUnit(element.dataset.unitId, { scrollPdf: true, preserveMode: true });
    });
  });
}

function renderMappingMarkdown() {
  const units = splitMarkdownUnits(mappingData.markdown || "", mappingData.document);
  mappingTextViewerEl.innerHTML = units.length > 0
    ? `<div class="mapping-markdown-list">${units.map((unit) => `
        <article class="mapping-markdown-unit ${unit.markdownAnchor && selectedMarkdownAnchor() === unit.markdownAnchor ? "selected" : ""}" data-markdown-anchor="${escapeHtml(unit.markdownAnchor || "")}">
          <p>${escapeHtml(unit.text)}</p>
        </article>
      `).join("")}</div>`
    : `<pre class="mapping-markdown">${escapeHtml(mappingData.markdown || "No Markdown found.")}</pre>`;
  scrollMappingMarkdownIntoView();
}

function renderMappingSections() {
  const sections = mappingData?.sections || [];
  mappingTextViewerEl.innerHTML = sections.length > 0
    ? sections.map((section, index) => {
        const key = sectionKey(section);
        return `
          <article class="mapping-section ${key === mappingSelectedSectionKey ? "selected" : ""}" data-mapping-section="${escapeHtml(key)}" data-index="${index}">
            <div class="mapping-block-head">
              <strong>${escapeHtml(section.hsCode || "n/a")}</strong>
              <span>p${escapeHtml(section.pageStart || "?")}-${escapeHtml(section.pageEnd || section.pageStart || "?")}</span>
            </div>
            <h3>${escapeHtml(section.title || section.section || "Untitled section")}</h3>
            <p>${escapeHtml(section.textPreview || "")}</p>
            <small>${escapeHtml(section.source || "source n/a")}</small>
          </article>
        `;
      }).join("")
    : "<div class=\"muted\">No sections.json records found.</div>";
  mappingTextViewerEl.querySelectorAll("[data-mapping-section]").forEach((element) => {
    element.addEventListener("click", () => {
      const section = sections[Number(element.dataset.index)];
      void selectMappingSection(section);
    });
  });
}

async function selectMappingBlock(blockId, options = {}) {
  const block = mappingData?.blocks.find((candidate) => candidate.id === blockId);
  if (!block) return;
  mappingSelectedBlockId = block.id;
  mappingSelectedSectionKey = block.section ? sectionKey(block) : null;
  mappingSelectedUnitId = mappingAlignmentIndex?.parsedTextUnits.find((unit) => unit.blockId === block.id)?.id || null;
  if (!options.preservePdfSpan) {
    mappingSelectedPdfSpanId = null;
  }
  mappingMatchInfo = { score: 0, confidence: options.confidence || "fallback", reasons: ["block-selection"] };
  if (block.pageNumber !== mappingCurrentPage) {
    await renderMappingPage(block.pageNumber);
  } else {
    renderMappingOverlays();
  }
  if (options.scrollText !== false && mappingModeSelect && !["blocks", "parsed-text"].includes(mappingModeSelect.value)) {
    mappingModeSelect.value = "parsed-text";
  }
  renderMappingTextViewer();
  renderMappingDetails(block, undefined, mappingAlignmentIndex?.parsedTextUnits.find((unit) => unit.id === mappingSelectedUnitId));
  if (options.scrollText !== false) {
    if (mappingModeSelect?.value === "parsed-text" && mappingSelectedUnitId) {
      scrollMappingUnitIntoView(mappingSelectedUnitId);
    } else {
      scrollMappingBlockIntoView(block.id);
    }
  }
  if (options.scrollPdf !== false) {
    mappingPdfStage?.scrollIntoView({ block: "nearest" });
  }
}

async function selectMappingSection(section) {
  if (!section) return;
  mappingSelectedSectionKey = sectionKey(section);
  mappingSelectedBlockId = null;
  mappingSelectedUnitId = null;
  mappingSelectedPdfSpanId = null;
  mappingMatchInfo = { score: 0, confidence: "fallback", reasons: ["section-page-fallback"] };
  const page = Number(section.pageStart) || 1;
  await renderMappingPage(page);
  renderMappingTextViewer();
  renderMappingDetails(undefined, section);
  scrollMappingSectionIntoView();
}

function renderMappingDetails(block, section, unit) {
  if (!mappingDetailsEl) return;
  const confidence = mappingMatchInfo?.confidence || "none";
  const reasonText = (mappingMatchInfo?.reasons || []).join(", ") || "n/a";
  if (section) {
    mappingDetailsEl.className = "mapping-details";
    mappingDetailsEl.innerHTML = `
      <dl>
        <dt>confidence</dt><dd>${escapeHtml(confidence)}</dd>
        <dt>section</dt><dd>${escapeHtml(section.section || "n/a")}</dd>
        <dt>hsCode</dt><dd>${escapeHtml(section.hsCode || "n/a")}</dd>
        <dt>title</dt><dd>${escapeHtml(section.title || "n/a")}</dd>
        <dt>page range</dt><dd>${escapeHtml(section.pageStart || "?")} - ${escapeHtml(section.pageEnd || section.pageStart || "?")}</dd>
        <dt>source</dt><dd>${escapeHtml(section.source || "n/a")}</dd>
      </dl>
    `;
    return;
  }
  if (!block) {
    mappingDetailsEl.className = "mapping-details muted";
    mappingDetailsEl.textContent = mappingMatchInfo?.confidence === "none"
      ? "No parsed text match found. Try block overlay fallback or a nearby text span."
      : "Click a PDF text span, PDF block, or parsed text unit to inspect mapping metadata.";
    return;
  }
  mappingDetailsEl.className = "mapping-details";
  mappingDetailsEl.innerHTML = `
    <dl>
      <dt>confidence</dt><dd>${escapeHtml(confidence)}</dd>
      <dt>match reasons</dt><dd>${escapeHtml(reasonText)}</dd>
      ${unit ? `<dt>unit</dt><dd>${escapeHtml(unit.id)} (${escapeHtml(unit.source)})</dd>` : ""}
      <dt>id</dt><dd>${escapeHtml(block.id)}</dd>
      <dt>page</dt><dd>${escapeHtml(block.pageNumber)}</dd>
      <dt>type</dt><dd>${escapeHtml(block.type)}</dd>
      <dt>bbox</dt><dd>${escapeHtml(`${round(block.bbox.x0)}, ${round(block.bbox.y0)}, ${round(block.bbox.x1)}, ${round(block.bbox.y1)}`)}</dd>
      <dt>section</dt><dd>${escapeHtml(block.section || "n/a")}</dd>
      <dt>hsCode/title</dt><dd>${escapeHtml([block.hsCode, block.title].filter(Boolean).join(" - ") || "n/a")}</dd>
      <dt>text</dt><dd>${escapeHtml(textPreview(block.text, 700))}</dd>
    </dl>
  `;
}

function currentMappingPageBlocks() {
  return (mappingData?.blocks || []).filter((block) => block.pageNumber === mappingCurrentPage);
}

function mappingBlockVisible(block) {
  const typeFilter = mappingTypeFilterSelect?.value || "all";
  if (typeFilter !== "all" && block.type !== typeFilter) return false;
  if (mappingSectionOnlyInput?.checked && mappingSelectedSectionKey) {
    return sectionKey(block) === mappingSelectedSectionKey;
  }
  return true;
}

function bboxToCanvasRect(bbox) {
  const scale = mappingViewportScale;
  const left = bbox.x0 * scale;
  const width = (bbox.x1 - bbox.x0) * scale;
  const height = (bbox.y1 - bbox.y0) * scale;
  const top = mappingInvertYInput?.checked
    ? (Number.parseFloat(mappingCanvas.style.height) || mappingCanvas.clientHeight) - bbox.y1 * scale
    : bbox.y0 * scale;
  return { left, top, width, height };
}

function scrollMappingBlockIntoView(blockId) {
  const element = mappingTextViewerEl?.querySelector(`[data-mapping-block-id="${cssEscape(blockId)}"]`);
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function scrollMappingUnitIntoView(unitId) {
  const element = mappingTextViewerEl?.querySelector(`[data-unit-id="${cssEscape(unitId)}"]`);
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function scrollMappingSectionIntoView() {
  if (!mappingSelectedSectionKey) return;
  const element = mappingTextViewerEl?.querySelector(`[data-mapping-section="${cssEscape(mappingSelectedSectionKey)}"]`);
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function scrollMappingMarkdownIntoView() {
  const anchor = selectedMarkdownAnchor();
  if (!anchor) return;
  const element = mappingTextViewerEl?.querySelector(`[data-markdown-anchor="${cssEscape(anchor)}"]`);
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function selectedMarkdownAnchor() {
  const unit = mappingAlignmentIndex?.parsedTextUnits.find((candidate) => candidate.id === mappingSelectedUnitId);
  if (unit?.markdownAnchor) return unit.markdownAnchor;
  if (mappingSelectedSectionKey) return markdownAnchorForText(mappingSelectedSectionKey);
  return "";
}

function markdownAnchorForText(text) {
  return normalizeTextForAlignment(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function setMappingStatus(message, warning = false) {
  if (!mappingCacheStatusEl) return;
  mappingCacheStatusEl.className = warning ? "mapping-status warning" : "mapping-status muted";
  mappingCacheStatusEl.textContent = message;
}

function formatMappingCacheStatus(payload) {
  const cache = payload.cacheStatus || {};
  return `Parse cache: ${cache.parse || "unknown"} | PageIndex cache: ${cache.pageIndex || "unknown"} | Mapping data: ${cache.mapping || "unknown"} | Blocks: ${(payload.blocks || []).length}`;
}

function sectionKey(item) {
  return item?.section || item?.hsCode || item?.title || "";
}

function blockArea(block) {
  const bbox = block.bbox || block;
  return Math.max(1, (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0));
}

function textPreview(value, limit = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

function renderMarkdown(markdown) {
  const escaped = escapeHtml(markdown)
    .replace(/!\[([^\]]*)\]\((assets\/[^)]+)\)/g, '<img src="/$2" alt="$1" loading="lazy" />')
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br />");
  return `<p>${escaped}</p>`;
}

function pageRange(section) {
  if (!section.pageStart && !section.pageEnd) return "";
  return section.pageStart === section.pageEnd || !section.pageEnd
    ? String(section.pageStart)
    : `${section.pageStart}-${section.pageEnd}`;
}

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function appendUiLog(message) {
  clientLogs.push(message);
  syncTerminalLogs();
}

function syncTerminalLogs(jobLogs = []) {
  const text = [...clientLogs, ...jobLogs].join("\n");
  logsEl.textContent = text;
  logsEl.scrollTop = logsEl.scrollHeight;
  if (chatTerminalEl) {
    chatTerminalEl.textContent = text || "No runtime logs yet.";
    chatTerminalEl.scrollTop = chatTerminalEl.scrollHeight;
  }
}

function traceLine(functionName, message, details = {}) {
  const entries = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "");
  const suffix = entries.length > 0
    ? ` | ${entries.map(([key, value]) => `${key}=${formatTraceValue(value)}`).join(" ")}`
    : "";
  return `[${new Date().toISOString()}] ${functionName}: ${message}${suffix}`;
}

function formatTraceValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map(formatTraceValue).join(",")}]`;
  }
  return String(value).replace(/\s+/g, "_");
}

async function saveApiKey(endpoint, apiKey, statusElement, extraPayload = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey, ...extraPayload })
  });
  const payload = await response.json();
  if (!response.ok) {
    statusElement.textContent = payload.error || "Failed to save API key.";
    return null;
  }
  return payload;
}

function uploadFormData(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        onProgress(undefined);
        return;
      }

      onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
    });

    xhr.addEventListener("load", () => {
      let payload = xhr.response;
      if (!payload && xhr.responseText) {
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = { error: xhr.responseText };
        }
      }

      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        payload: payload || {}
      });
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted.")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out.")));
    xhr.send(body);
  });
}

async function saveGeminiKeyEnabled(slot, enabled) {
  const response = await fetch("/api/settings/gemini-key-enabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slot, enabled })
  });
  const payload = await response.json();
  if (!response.ok) {
    geminiSettingsStatusEl.textContent = payload.error || "Failed to update Gemini slot.";
    return null;
  }
  return payload;
}

function syncGeminiEnabledInputs() {
  const byName = new Map((settings.geminiKeySlots || []).map((slot) => [slot.name, slot]));
  geminiKeyEnabledInputs.forEach((input) => {
    const slot = byName.get(input.dataset.slot);
    input.checked = slot?.enabled !== false;
  });
}

function selectedGeminiKeys() {
  if (!temporaryGeminiKeyInput.checked) {
    return [];
  }

  return geminiKeyInputs
    .filter((input) => isGeminiSlotEnabled(input.dataset.slot))
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function isGeminiSlotEnabled(slotName) {
  const input = geminiKeyEnabledInputs.find((candidate) => candidate.dataset.slot === slotName);
  return input ? input.checked : true;
}

async function loadSettings() {
  const response = await fetch("/api/settings");
  const payload = await response.json();
  if (!response.ok) {
    pageIndexSettingsStatusEl.textContent = "Could not load settings.";
    geminiSettingsStatusEl.textContent = "Could not load settings.";
    return;
  }
  settings = payload;
  syncGeminiEnabledInputs();
  const secretWriteNote = payload.localDemoSecretWriteEnabled === false
    ? " Save disabled unless env variables are set outside the UI."
    : "";
  pageIndexSettingsStatusEl.textContent = payload.hasPageIndexApiKey
    ? `PageIndex key configured: yes (${payload.maskedPageIndexApiKey}).${secretWriteNote}`
    : `PageIndex key configured: no.${secretWriteNote}`;
  geminiSettingsStatusEl.textContent = payload.hasGeminiApiKey
    ? `Gemini keys configured: ${payload.configuredGeminiKeyCount || 1} (${payload.maskedGeminiApiKey})`
    : "Gemini keys configured: no";
  renderGeminiSettingsStatus();
  updatePageIndexWarning();
}

async function loadIndexedDocuments() {
  const response = await fetch("/api/pageindex-documents");
  const payload = await response.json();
  if (!response.ok) {
    indexedDocuments = [];
    updateAgentScope();
    updateChatGate();
    return;
  }

  indexedDocuments = payload.documents || [];
  mergeAvailableSources(indexedDocuments.map((document) => ({
    document: document.document,
    docId: document.docId,
    treePath: document.treePath,
    pageIndexCacheStatus: document.pageIndexCacheStatus || "fresh",
    treeStatus: document.pageIndexCacheStatus === "fresh" ? "fresh" : "cached"
  })));
  if (hasProcessedSources()) {
    showChatScreen();
  } else {
    showSetupScreen();
  }
  updateAgentScope();
}

function mergeIndexedDocuments(documents) {
  const byDocId = new Map(indexedDocuments.map((document) => [document.docId, document]));
  for (const document of documents) {
    if (document.docId) {
      byDocId.set(document.docId, document);
    }
  }
  indexedDocuments = [...byDocId.values()].sort((left, right) => String(left.document).localeCompare(String(right.document)));
  mergeAvailableSources(documents.map((document) => ({
    document: document.document,
    docId: document.docId,
    treePath: document.treePath,
    pageIndexCacheStatus: "fresh",
    treeStatus: document.treePath ? "fresh" : "missing"
  })));
  updateAgentScope();
}

function renderGeminiSettingsStatus() {
  const slots = settings.geminiKeySlots || [];
  if (slots.length === 0) {
    geminiSettingsStatusEl.textContent = settings.hasGeminiApiKey
      ? `Gemini keys configured: ${settings.configuredGeminiKeyCount || 1} (${settings.maskedGeminiApiKey})`
      : "Gemini keys configured: no";
    return;
  }

  const summary = slots
    .map((slot) => {
      const keyLabel = slot.configured ? slot.maskedKey : "empty";
      const state = slot.enabled === false ? "disabled" : "enabled";
      return `${slot.name.replace("GEMINI_KEY_", "#")}: ${keyLabel} (${state})`;
    })
    .join(" | ");
  const legacy = settings.legacyGeminiKeyConfigured ? ` | legacy: ${settings.maskedLegacyGeminiApiKey}` : "";
  const enabledCount = settings.enabledGeminiKeyCount ?? slots.filter((slot) => slot.configured && slot.enabled !== false).length;
  geminiSettingsStatusEl.textContent = `Gemini slots: ${summary}${legacy} | active saved slots: ${enabledCount}`;
}

function updatePageIndexWarning() {
  const hasTemporaryKey = pageIndexKeyInput.value.trim().length > 0;
  const uploadMayRun = uploadPageIndexInput.checked && (
    forcePageIndexUploadInput.checked ||
    !reusePageIndexCacheInput.checked ||
    selectedCacheRows.length === 0 ||
    selectedCacheRows.some((row) => row.pageIndexCacheStatus !== "fresh")
  );
  const shouldWarn =
    uploadPageIndexInput.checked &&
    !settings.hasPageIndexApiKey &&
    !hasTemporaryKey &&
    uploadMayRun;
  pageIndexWarningEl.classList.toggle("hidden", !shouldWarn);
  renderCacheSummary();
}

function renderCacheSummary() {
  if (!cacheStatusSummaryEl) return;
  const messages = [];
  if (uploadPageIndexInput.checked) {
    const freshCount = selectedCacheRows.filter((row) => row.pageIndexCacheStatus === "fresh").length;
    if (freshCount > 0 && reusePageIndexCacheInput.checked && !forcePageIndexUploadInput.checked) {
      messages.push("PageIndex tree already exists and matches current Markdown. It will be reused unless Force re-upload is enabled.");
    }
  } else {
    messages.push("PageIndex upload disabled. Q&A may use existing cached tree if available.");
  }

  const cachedRows = selectedCacheRows.filter((row) => row.hasTree || row.treeStatus === "fresh" || row.treeStatus === "stale" || row.treeStatus === "cached");
  if (cachedRows.length > 0) {
    const stale = cachedRows.filter((row) => row.pageIndexCacheStatus === "stale").length;
    const fresh = cachedRows.filter((row) => row.pageIndexCacheStatus === "fresh").length;
    if (fresh > 0) messages.push(`Cached PageIndex tree: fresh (${fresh}).`);
    if (stale > 0) messages.push(`Cached PageIndex tree: stale; Markdown changed since tree generation (${stale}).`);
  }

  cacheStatusSummaryEl.className = messages.some((message) => message.includes("stale") || message.includes("disabled"))
    ? "cache-summary warning"
    : "cache-summary muted";
  cacheStatusSummaryEl.textContent = messages.join(" ") || "Select PDFs to inspect cache status.";
}

function togglePasswordInput(input, button) {
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  button.textContent = isPassword ? "Hide" : "Show";
}

function statusChip(value) {
  const text = String(value || "n/a");
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "idle";
  return `<span class="status-chip ${escapeHtml(normalized)}">${escapeHtml(text)}</span>`;
}

function plainOrChip(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (/^(passed|failed|completed|queued|running|waiting|yes|none|skipped|fresh|stale|missing|cached|uploaded)$/i.test(text)) {
    return statusChip(text);
  }
  return escapeHtml(text);
}

function parseDocIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
.replaceAll('"', "&quot;");
}
