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
const questionDebugInput = document.querySelector("#question-debug");
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

let activeJobId = null;
let pollTimer = null;
let selectedDocument = null;
let selectedBundle = null;
let indexedDocuments = [];
let currentPdfUrl = "";
let currentPage = 1;
let clientLogs = [];
let selectedCacheRows = [];
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
questionAllDocsInput.addEventListener("change", updateAgentScope);
questionDocIdInput.addEventListener("input", updateAgentScope);
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
  const selectedDocIds = selectedBundle?.pageIndexDocId ? [selectedBundle.pageIndexDocId] : [];
  const allCachedDocIds = indexedDocuments.map((document) => document.docId).filter(Boolean);
  const docIds = questionAllDocsInput.checked
    ? uniqueStrings([...allCachedDocIds, ...manualDocIds])
    : uniqueStrings([...manualDocIds, ...selectedDocIds]);
  if (!question) {
    answerEl.className = "warning";
    answerEl.textContent = "Enter a question first.";
    return;
  }
  const canUseSelectedLocalSections = Boolean(selectedBundle?.document && Array.isArray(selectedBundle.sections) && selectedBundle.sections.length > 0);
  if (docIds.length === 0 && !questionAllDocsInput.checked && !canUseSelectedLocalSections) {
    answerEl.className = "warning";
    answerEl.textContent = "No PageIndex docs are available. Run Upload to PageIndex once, keep cached tree files, or paste doc_id manually.";
    return;
  }
  answerEl.className = "muted";
  answerEl.textContent = questionAllDocsInput.checked
    ? `Searching cached tree JSON across ${indexedDocuments.length} PDF(s)...`
    : docIds.length > 0
      ? `Asking PageIndex Chat across ${docIds.length} document(s)...`
      : `Searching local sections for ${selectedBundle.document}...`;
  const body = {
    question,
    docIds,
    scope: questionAllDocsInput.checked ? "all" : docIds.length > 0 ? "selected" : "local-sections",
    document: selectedBundle?.document,
    debug: Boolean(questionDebugInput?.checked)
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
    answerEl.className = "warning";
    answerEl.textContent = payload.error || "Could not get answer.";
    return;
  }
  answerEl.className = "";
  const marker = payload.validation?.markers?.[0];
  const answerScope = payload.mode === "cached-tree"
    ? `Scope: cached tree JSON (${(payload.documents || []).length} source PDF(s))`
    : payload.mode === "local-sections"
      ? `Scope: local sections (${(payload.documents || []).length} source PDF(s))`
      : `Scope: ${(payload.docIds || docIds).length} PageIndex document(s)`;
  const indexSource = payload.indexSource || selectedIndexSource();
  const retrievalStatus = renderRetrievalStatus(payload.retrieval, indexSource);
  const citationCards = renderCitationCards(payload.citations || []);
  const debugPanel = questionDebugInput?.checked ? renderDebugPanel(payload.debug) : "";
  answerEl.innerHTML = `
    <div class="answer-box">
      <div class="answer-text">${escapeHtml(payload.answer || "")}</div>
      ${retrievalStatus}
      ${citationCards}
      ${debugPanel}
      <p>${escapeHtml(answerScope)}</p>
      ${marker ? `<p>${escapeHtml(marker.message || "")}</p>` : ""}
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
  logsEl.textContent = [...clientLogs, ...(job.logs || [])].join("\n");
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
  const firstDocument = payload.selectedDocument || payload.outputs?.selectedDocument;
  if (firstDocument) {
    await loadDocument(firstDocument);
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

  batchTableEl.querySelectorAll("tr[data-document]").forEach((row) => {
    row.addEventListener("click", () => loadDocument(row.dataset.document));
  });
}

function batchTableMarkup(rows, live) {
  return `
    <table>
      <thead>
        <tr>
          <th>Document</th><th>Parse Cache</th><th>PageIndex Cache</th><th>Assets</th>
          <th>Sections</th><th>Tree</th><th>Action</th><th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr data-document="${escapeHtml(row.document)}" class="${selectedDocument === row.document ? "selected" : ""}">
            <td>
              <strong>${escapeHtml(row.document)}</strong>
              <div class="mini-progress"><span style="width:${Number(row.progressPercent || 0)}%"></span></div>
            </td>
            <td>${statusChip(row.parseCache || row.status)}</td>
            <td>${statusChip(row.pageIndexCache || "n/a")}</td>
            <td>${plainOrChip(row.assets)}</td>
            <td>${plainOrChip(row.sections)}</td>
            <td>${plainOrChip(row.tree)}</td>
            <td>${escapeHtml(row.action)}</td>
            <td class="error-cell">${escapeHtml(row.error)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    ${live ? "<p class=\"muted\">Rows become clickable when results are available.</p>" : ""}
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
      <strong>${index === 0 ? "Primary citation" : "Related citation"}</strong>
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

function renderRetrievalStatus(retrieval, indexSource) {
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
      ${indexSource?.warning ? `<span>${escapeHtml(indexSource.warning)}</span>` : ""}
      ${documentDetails}
    </div>
  `;
}

function renderDebugPanel(debug) {
  if (!debug) {
    return "";
  }

  const selected = debug.selectedPrimary && Object.keys(debug.selectedPrimary).length > 0
    ? renderDebugSelected(debug.selectedPrimary)
    : "";
  const candidates = Array.isArray(debug.candidates) ? debug.candidates : [];
  return `
    <details class="debug-panel" open>
      <summary>Q&A debug</summary>
      ${selected}
      <dl>
        <dt>Signals</dt><dd><pre>${escapeHtml(JSON.stringify(debug.extractedSignals || {}, null, 2))}</pre></dd>
        <dt>Retrieval</dt><dd><pre>${escapeHtml(JSON.stringify(debug.retrieval || {}, null, 2))}</pre></dd>
      </dl>
      <div class="debug-candidates">
        ${candidates.slice(0, 8).map(renderDebugCandidate).join("")}
      </div>
    </details>
  `;
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
  clientLogs = [];
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

function updateAgentScope(bundle) {
  if (Array.isArray(bundle)) {
    indexedDocuments = bundle;
  }

  const manualDocIds = parseDocIds(questionDocIdInput.value);
  if (questionAllDocsInput.checked) {
    const docIdCount = uniqueStrings([...indexedDocuments.map((document) => document.docId).filter(Boolean), ...manualDocIds]).length;
    questionDocScopeEl.textContent = indexedDocuments.length > 0
      ? `Scope: all cached tree PDFs (${indexedDocuments.length}); PageIndex doc_id values: ${docIdCount}.`
      : "Scope: all cached tree PDFs, but no cached tree JSON was found.";
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
  logsEl.textContent = clientLogs.join("\n");
  logsEl.scrollTop = logsEl.scrollHeight;
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
  pageIndexSettingsStatusEl.textContent = payload.hasPageIndexApiKey
    ? `PageIndex key configured: yes (${payload.maskedPageIndexApiKey})`
    : "PageIndex key configured: no";
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
    return;
  }

  indexedDocuments = payload.documents || [];
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
