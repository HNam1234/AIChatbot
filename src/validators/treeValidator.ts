import type { SectionMapResult, ValidationMarkerResult, ValidationReport } from "../types";

export interface TreeValidationOptions {
  docId?: string;
  sectionMap?: SectionMapResult;
  requireNodeId?: boolean;
  requireSummary?: boolean;
}

interface TreeNodeRef {
  title: string;
  level: number;
  nodeId?: string;
  summary?: string;
  textContent: string;
  childCount: number;
}

interface TreeFieldStats {
  idFieldNamesDetected: Set<string>;
  summaryFieldNamesDetected: Set<string>;
  childFieldNamesDetected: Set<string>;
}

const HS_CODE_REGEX = /\b\d{4}\.\d{2}\.\d{2}\b/g;
const ID_FIELD_NAMES = ["node_id", "nodeId", "id", "uid"] as const;
const SUMMARY_FIELD_NAMES = ["summary", "node_summary", "nodeSummary", "description", "prefix_summary"] as const;
const CHILD_FIELD_NAMES = ["nodes", "children"] as const;

export class TreeValidator {
  public static validate(markdownText: string, treePayload: unknown, options: TreeValidationOptions = {}): ValidationReport {
    const warnings: string[] = [];
    const marker = validateTreeIntegrity(markdownText, treePayload, options, warnings);
    const errors = marker.passed ? [] : [marker.message];

    return {
      passed: marker.passed,
      markers: [marker],
      errors,
      warnings
    };
  }
}

function validateTreeIntegrity(
  markdownText: string,
  treePayload: unknown,
  options: TreeValidationOptions,
  warnings: string[]
): ValidationMarkerResult {
  const expectedHsCodes = uniqueStrings(extractHsCodes(markdownText));
  const documentType = expectedHsCodes.length === 0 ? "non-hs-reference" : "hs-code-reference";
  const sectionMapSections = Array.isArray(options.sectionMap?.sections) ? options.sectionMap.sections : undefined;
  const sectionMapHsCodes = new Set(sectionMapSections?.map((section) => section.hsCode) ?? []);
  const treeRoots = normalizeTreeRoots(treePayload);
  const fieldStats: TreeFieldStats = {
    idFieldNamesDetected: new Set<string>(),
    summaryFieldNamesDetected: new Set<string>(),
    childFieldNamesDetected: new Set<string>()
  };
  const treeNodes = flattenTreeNodes(treeRoots, fieldStats);
  const detectedHsCodesInTree = uniqueStrings(treeNodes.flatMap((node) => extractHsCodes(node.textContent)));
  const missingHsCodesInTree = expectedHsCodes.filter((hsCode) => !detectedHsCodesInTree.includes(hsCode));
  const missingHsCodesInSectionMap = expectedHsCodes.filter((hsCode) => !sectionMapHsCodes.has(hsCode));
  const nodeWithIdCount = treeNodes.filter((node) => node.nodeId).length;
  const nodeWithSummaryCount = treeNodes.filter((node) => node.summary).length;
  const missingSummaryHsCodes = expectedHsCodes.filter((hsCode) => {
    const matchedNode = treeNodes.find((node) => node.textContent.includes(hsCode));
    return matchedNode !== undefined && !matchedNode.summary;
  });

  for (const hsCode of missingSummaryHsCodes) {
    warnings.push(`Tree node for HS code ${hsCode} has no summary field.`);
  }

  const missingPageRanges = sectionMapSections
    ?.filter((section) => section.pageStart === null || section.pageEnd === null)
    .map((section) => section.hsCode) ?? [];
  for (const hsCode of missingPageRanges) {
    warnings.push(`Section map has no confident page range for HS code ${hsCode}.`);
  }
  for (const warning of options.sectionMap?.warnings ?? []) {
    warnings.push(warning);
  }

  const details = {
    docId: options.docId,
    documentType,
    markdownHSCodeCount: expectedHsCodes.length,
    treeMatchedHSCodeCount: expectedHsCodes.length - missingHsCodesInTree.length,
    sectionMapHSCodeCount: sectionMapHsCodes.size,
    expectedHsCodes,
    detectedHsCodesInTree,
    missingHsCodesInTree,
    missingHsCodesInSectionMap,
    nodeCount: treeNodes.length,
    nodeWithIdCount,
    nodeWithSummaryCount,
    idFieldNamesDetected: [...fieldStats.idFieldNamesDetected].sort(),
    summaryFieldNamesDetected: [...fieldStats.summaryFieldNamesDetected].sort(),
    childFieldNamesDetected: [...fieldStats.childFieldNamesDetected].sort()
  };

  const errors: string[] = [];
  if (treePayload === undefined || treePayload === null || treeRoots.length === 0 || treeNodes.length === 0) {
    errors.push("tree-missing-or-invalid");
  }
  if (documentType === "hs-code-reference" && missingHsCodesInTree.length > 0) {
    errors.push("missing-hs-codes-in-tree");
  }
  if (documentType === "hs-code-reference" && (!sectionMapSections || sectionMapSections.length === 0)) {
    errors.push("section-map-missing-or-invalid");
  }
  if (documentType === "hs-code-reference" && missingHsCodesInSectionMap.length > 0) {
    errors.push("missing-hs-codes-in-section-map");
  }

  if (errors.length > 0) {
    return {
      marker: "MARKER 10",
      passed: false,
      message: `[Marker 10 Failed] PageIndex tree or local section map is structurally invalid: ${errors.join(", ")}.`,
      details
    };
  }

  return {
    marker: "MARKER 10",
    passed: true,
    message: "[Marker 10 Passed] PageIndex tree and local section map are structurally valid.",
    details
  };
}

function normalizeTreeRoots(treePayload: unknown): unknown[] {
  if (Array.isArray(treePayload)) {
    return treePayload;
  }

  if (typeof treePayload !== "object" || treePayload === null) {
    return [];
  }

  const record = treePayload as Record<string, unknown>;
  const directTree = arrayValue(record.tree);
  if (directTree) {
    return directTree;
  }

  const rawResponse = objectValue(record.rawResponse);
  const rawStructure = rawResponse ? arrayValue(rawResponse.structure) : undefined;
  if (rawStructure) {
    return rawStructure;
  }

  for (const key of ["structure", "result"] as const) {
    const value = arrayValue(record[key]);
    if (value) {
      return value;
    }
  }

  return [];
}

function flattenTreeNodes(nodes: unknown[], fieldStats: TreeFieldStats, level = 1): TreeNodeRef[] {
  const refs: TreeNodeRef[] = [];

  for (const node of nodes) {
    if (typeof node !== "object" || node === null) {
      continue;
    }

    const record = node as Record<string, unknown>;
    const children = collectChildren(record, fieldStats);
    const nodeId = firstStringField(record, ID_FIELD_NAMES, fieldStats.idFieldNamesDetected);
    const summary = firstStringField(record, SUMMARY_FIELD_NAMES, fieldStats.summaryFieldNamesDetected);
    const textContent = collectStrings(record).map(cleanText).join(" ");
    const title =
      stringValue(record.title) ??
      stringValue(record.heading) ??
      stringValue(record.name) ??
      firstHsCodeText(textContent) ??
      textContent.slice(0, 80);

    if (title || textContent) {
      refs.push({
        title: cleanText(title || textContent.slice(0, 80)),
        level,
        nodeId,
        summary,
        textContent,
        childCount: children.length
      });
    }

    refs.push(...flattenTreeNodes(children, fieldStats, level + 1));
  }

  return refs;
}

function collectChildren(record: Record<string, unknown>, fieldStats: TreeFieldStats): unknown[] {
  const children: unknown[] = [];
  for (const key of CHILD_FIELD_NAMES) {
    const value = arrayValue(record[key]);
    if (value) {
      fieldStats.childFieldNamesDetected.add(key);
      children.push(...value);
    }
  }
  return children;
}

function firstStringField(
  record: Record<string, unknown>,
  fieldNames: readonly string[],
  detectedFields: Set<string>
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = stringValue(record[fieldName]);
    if (value) {
      detectedFields.add(fieldName);
      return value;
    }
  }

  return undefined;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function extractHsCodes(text: string): string[] {
  return text.match(HS_CODE_REGEX) ?? [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstHsCodeText(text: string): string | undefined {
  return extractHsCodes(text)[0];
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
