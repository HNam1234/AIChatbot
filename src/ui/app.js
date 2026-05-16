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
const answerEl = document.querySelector("#answer");
const pageIndexKeyInput = document.querySelector("#pageindex-key");
const geminiKeyInput = document.querySelector("#gemini-key");
const temporaryPageIndexKeyInput = document.querySelector("#temporary-pageindex-key");
const temporaryGeminiKeyInput = document.querySelector("#temporary-gemini-key");
const uploadPageIndexInput = document.querySelector("#upload-pageindex");
const pageIndexSettingsStatusEl = document.querySelector("#pageindex-settings-status");
const geminiSettingsStatusEl = document.querySelector("#gemini-settings-status");
const savePageIndexKeyButton = document.querySelector("#save-pageindex-key");
const saveGeminiKeyButton = document.querySelector("#save-gemini-key");
const togglePageIndexKeyButton = document.querySelector("#toggle-pageindex-key");
const toggleGeminiKeyButton = document.querySelector("#toggle-gemini-key");
const pageIndexWarningEl = document.querySelector("#pageindex-warning");

let activeJobId = null;
let pollTimer = null;
let selectedDocument = null;
let currentPdfUrl = "";
let currentPage = 1;
let settings = {
  hasPageIndexApiKey: false,
  maskedPageIndexApiKey: null,
  hasGeminiApiKey: false,
  maskedGeminiApiKey: null
};

void loadSettings();

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

fileInput.addEventListener("change", renderSelectedFiles);
pageIndexKeyInput.addEventListener("input", updatePageIndexWarning);
uploadPageIndexInput.addEventListener("change", updatePageIndexWarning);
prevPageButton.addEventListener("click", () => setPdfPage(Math.max(1, currentPage - 1)));
nextPageButton.addEventListener("click", () => setPdfPage(currentPage + 1));
pageNumberInput.addEventListener("change", () => setPdfPage(Number(pageNumberInput.value) || 1));

togglePageIndexKeyButton.addEventListener("click", () => togglePasswordInput(pageIndexKeyInput, togglePageIndexKeyButton));
toggleGeminiKeyButton.addEventListener("click", () => togglePasswordInput(geminiKeyInput, toggleGeminiKeyButton));

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

saveGeminiKeyButton.addEventListener("click", async () => {
  const apiKey = geminiKeyInput.value.trim();
  if (!apiKey) {
    geminiSettingsStatusEl.textContent = "Enter a Gemini API key first.";
    return;
  }
  const payload = await saveApiKey("/api/settings/gemini-key", apiKey, geminiSettingsStatusEl);
  if (!payload) return;
  geminiKeyInput.value = "";
  settings.hasGeminiApiKey = true;
  settings.maskedGeminiApiKey = payload.maskedKey;
  geminiSettingsStatusEl.textContent = `Gemini key configured: yes (${payload.maskedKey})`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearInterval(pollTimer);
  resetResult();

  if (uploadPageIndexInput.checked && !settings.hasPageIndexApiKey && !pageIndexKeyInput.value.trim()) {
    setTopStatus({ status: "failed", currentStep: "Missing PageIndex API key", progressPercent: 0 });
    pageIndexWarningEl.classList.remove("hidden");
    logsEl.textContent = "Enter PageIndex API key in API Settings or create .env.";
    return;
  }

  const body = new FormData(form);
  if (temporaryPageIndexKeyInput.checked && pageIndexKeyInput.value.trim()) {
    body.set("temporaryPageIndexApiKey", pageIndexKeyInput.value.trim());
  } else {
    body.delete("temporaryPageIndexApiKey");
  }
  if (temporaryGeminiKeyInput.checked && geminiKeyInput.value.trim()) {
    body.set("temporaryGeminiApiKey", geminiKeyInput.value.trim());
  } else {
    body.delete("temporaryGeminiApiKey");
  }

  setTopStatus({ status: "queued", currentStep: "uploading", progressPercent: 0 });
  renderSelectedFiles("waiting");

  const response = await fetch("/api/run-pipeline", { method: "POST", body });
  const payload = await response.json();
  if (!response.ok) {
    setTopStatus({ status: "failed", currentStep: payload.error || "Failed to start pipeline", progressPercent: 0 });
    logsEl.textContent = payload.error || "Failed to start pipeline.";
    return;
  }

  activeJobId = payload.jobId;
  pollTimer = setInterval(pollStatus, 1500);
  await pollStatus();
});

askButton.addEventListener("click", async () => {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: questionInput.value })
  });
  const payload = await response.json();
  answerEl.textContent = payload.answer;
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
  logsEl.textContent = (job.logs || []).join("\n");
  renderBatchStatus(job.files || []);

  if (job.status === "completed" || job.status === "failed") {
    clearInterval(pollTimer);
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
  jobStatusEl.textContent = job.status || "Idle";
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
  selectedFilesEl.innerHTML = files.map((file) => `
    <div class="file-row">
      <span>${escapeHtml(file.name)}</span>
      <span>${formatBytes(file.size)}</span>
      <span class="pill">${status}</span>
    </div>
  `).join("");
}

function renderBatchStatus(files) {
  if (files.length === 0) return;
  batchTableEl.classList.remove("muted");
  batchTableEl.innerHTML = batchTableMarkup(files.map((file) => ({
    document: file.filename,
    status: file.status,
    progressPercent: file.progressPercent,
    parse: file.status,
    assets: "",
    sections: "",
    pageIndex: "",
    treeValidation: "",
    hsSectionCount: "",
    imageCount: "",
    error: file.error || ""
  })), true);
}

function renderBatchOutputs(outputs) {
  if (outputs.length === 0) return;
  batchTableEl.classList.remove("muted");
  batchTableEl.innerHTML = batchTableMarkup(outputs.map((output) => ({
    document: output.document,
    status: output.status,
    progressPercent: 100,
    parse: output.status,
    assets: output.imagesExported > 0 ? "yes" : "none",
    sections: output.hsSections > 0 ? "yes" : "none",
    pageIndex: output.pageIndex || "skipped",
    treeValidation: output.treeValidation?.passed === true ? "passed" : output.treeValidation ? "failed" : "skipped",
    hsSectionCount: output.hsSections ?? 0,
    imageCount: output.imagesExported ?? 0,
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
          <th>Document</th><th>Parse</th><th>Assets</th><th>Sections</th><th>PageIndex</th>
          <th>Tree Validation</th><th>HS Sections</th><th>Images</th><th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr data-document="${escapeHtml(row.document)}" class="${selectedDocument === row.document ? "selected" : ""}">
            <td>
              <strong>${escapeHtml(row.document)}</strong>
              <div class="mini-progress"><span style="width:${Number(row.progressPercent || 0)}%"></span></div>
            </td>
            <td>${escapeHtml(row.parse || row.status)}</td>
            <td>${escapeHtml(row.assets)}</td>
            <td>${escapeHtml(row.sections)}</td>
            <td>${escapeHtml(row.pageIndex)}</td>
            <td>${escapeHtml(row.treeValidation)}</td>
            <td>${escapeHtml(row.hsSectionCount)}</td>
            <td>${escapeHtml(row.imageCount)}</td>
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
  markdownEl.textContent = "No Markdown yet.";
  renderedEl.textContent = "No rendered preview yet.";
  sectionsEl.textContent = "No sections yet.";
  sectionDetailEl.textContent = "Select a section to inspect page mapping.";
  treeEl.textContent = "No tree JSON yet.";
  markersEl.textContent = "No markers yet.";
  imagesEl.textContent = "No images yet.";
  batchTableEl.textContent = "No documents yet.";
  pdfFrame.removeAttribute("src");
  currentPdfUrl = "";
  selectedDocument = null;
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

async function saveApiKey(endpoint, apiKey, statusElement) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey })
  });
  const payload = await response.json();
  if (!response.ok) {
    statusElement.textContent = payload.error || "Failed to save API key.";
    return null;
  }
  return payload;
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
  pageIndexSettingsStatusEl.textContent = payload.hasPageIndexApiKey
    ? `PageIndex key configured: yes (${payload.maskedPageIndexApiKey})`
    : "PageIndex key configured: no";
  geminiSettingsStatusEl.textContent = payload.hasGeminiApiKey
    ? `Gemini key configured: yes (${payload.maskedGeminiApiKey})`
    : "Gemini key configured: no";
  updatePageIndexWarning();
}

function updatePageIndexWarning() {
  const hasTemporaryKey = pageIndexKeyInput.value.trim().length > 0;
  const shouldWarn = uploadPageIndexInput.checked && !settings.hasPageIndexApiKey && !hasTemporaryKey;
  pageIndexWarningEl.classList.toggle("hidden", !shouldWarn);
}

function togglePasswordInput(input, button) {
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  button.textContent = isPassword ? "Hide" : "Show";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
