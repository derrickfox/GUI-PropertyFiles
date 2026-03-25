import { useEffect, useMemo, useState } from "react";

const PROPERTY_EXTENSION = ".properties";

function getPathSegments(path = "") {
  return path.split("/").filter(Boolean).filter((segment) => segment !== ".");
}

function getEnvironmentName(filePath) {
  const segments = getPathSegments(filePath);

  if (segments.length < 2) {
    return "";
  }

  return segments[0];
}

function getEnvironmentRelativePath(filePath) {
  const segments = getPathSegments(filePath);

  if (segments.length < 2) {
    return "";
  }

  return segments.slice(1).join("/");
}

function collectEnvironmentOptions(files = []) {
  const environments = new Set();

  for (const file of files) {
    const environment = getEnvironmentName(file.path);

    if (environment) {
      environments.add(environment);
    }
  }

  return Array.from(environments).sort((left, right) => left.localeCompare(right));
}

function parsePropertyLine(line) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    return null;
  }

  const match = line.match(/^([^=:]+?)\s*([=:])\s*(.*)$/);

  if (!match) {
    return null;
  }

  return {
    key: match[1].trim(),
    value: match[3].trim()
  };
}

function parsePropertiesContent(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];

  for (const [index, line] of lines.entries()) {
    const parsed = parsePropertyLine(line);

    if (!parsed) {
      continue;
    }

    entries.push({
      key: parsed.key,
      value: parsed.value,
      lineNumber: index + 1
    });
  }

  return entries;
}

function comparePropertiesData(leftEntries, rightEntries) {
  const leftMap = new Map(leftEntries.map((entry) => [entry.key, entry.value]));
  const rightMap = new Map(rightEntries.map((entry) => [entry.key, entry.value]));
  const leftOnly = [];
  const rightOnly = [];
  const valueDifferences = [];

  for (const [key, value] of leftMap.entries()) {
    if (!rightMap.has(key)) {
      leftOnly.push({ key, value });
      continue;
    }

    const rightValue = rightMap.get(key);
    if (rightValue !== value) {
      valueDifferences.push({
        key,
        leftValue: value,
        rightValue
      });
    }
  }

  for (const [key, value] of rightMap.entries()) {
    if (!leftMap.has(key)) {
      rightOnly.push({ key, value });
    }
  }

  leftOnly.sort((a, b) => a.key.localeCompare(b.key));
  rightOnly.sort((a, b) => a.key.localeCompare(b.key));
  valueDifferences.sort((a, b) => a.key.localeCompare(b.key));

  return {
    leftOnly,
    rightOnly,
    valueDifferences
  };
}

function hasDiffContent(diff) {
  return Boolean(
    diff.leftOnly.length || diff.rightOnly.length || diff.valueDifferences.length
  );
}

function buildReporterData(fileRecords = [], leftEnvironment, rightEnvironment) {
  const environmentFiles = new Map();

  for (const fileRecord of fileRecords) {
    const environment = getEnvironmentName(fileRecord.path);
    const relativePath = getEnvironmentRelativePath(fileRecord.path);

    if (!environment || !relativePath) {
      continue;
    }

    if (!environmentFiles.has(environment)) {
      environmentFiles.set(environment, new Map());
    }

    environmentFiles.get(environment).set(relativePath, fileRecord);
  }

  const leftFiles = environmentFiles.get(leftEnvironment) || new Map();
  const rightFiles = environmentFiles.get(rightEnvironment) || new Map();
  const allRelativePaths = Array.from(
    new Set([...leftFiles.keys(), ...rightFiles.keys()])
  ).sort((left, right) => left.localeCompare(right));
  const files = [];
  const leftOnlyFiles = [];
  const rightOnlyFiles = [];

  for (const relativePath of allRelativePaths) {
    const leftFile = leftFiles.get(relativePath);
    const rightFile = rightFiles.get(relativePath);

    if (!leftFile) {
      rightOnlyFiles.push({
        relativePath,
        fileName: rightFile?.name || relativePath.split("/").pop() || relativePath,
        path: rightFile?.path || ""
      });
      continue;
    }

    if (!rightFile) {
      leftOnlyFiles.push({
        relativePath,
        fileName: leftFile.name,
        path: leftFile.path
      });
      continue;
    }

    const diff = comparePropertiesData(leftFile.entries, rightFile.entries);

    if (!hasDiffContent(diff)) {
      continue;
    }

    files.push({
      relativePath,
      fileName: leftFile.name,
      leftPath: leftFile.path,
      rightPath: rightFile.path,
      diff
    });
  }

  return {
    leftEnvironment,
    rightEnvironment,
    files,
    leftOnlyFiles,
    rightOnlyFiles,
    summary: {
      comparedFileCount: allRelativePaths.length,
      changedFileCount: files.length,
      leftOnlyFileCount: leftOnlyFiles.length,
      rightOnlyFileCount: rightOnlyFiles.length
    }
  };
}

async function scanDirectoryHandle(directoryHandle, segments = []) {
  const children = [];
  const files = [];
  const fileContents = new Map();
  const suggestionIndex = new Map();

  for await (const entry of directoryHandle.values()) {
    if (entry.kind === "directory") {
      const scannedChild = await scanDirectoryHandle(entry, [...segments, entry.name]);

      if (scannedChild.tree.children.length > 0) {
        children.push(scannedChild.tree);
        files.push(...scannedChild.files);

        for (const [key, value] of scannedChild.fileContents.entries()) {
          fileContents.set(key, value);
        }

        for (const [key, values] of scannedChild.suggestionIndex.entries()) {
          if (!suggestionIndex.has(key)) {
            suggestionIndex.set(key, new Set());
          }

          for (const value of values) {
            suggestionIndex.get(key).add(value);
          }
        }
      }

      continue;
    }

    if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(PROPERTY_EXTENSION)) {
      continue;
    }

    const path = [...segments, entry.name].join("/");
    const file = await entry.getFile();
    const content = await file.text();
    const entries = parsePropertiesContent(content);
    const fileNode = {
      type: "file",
      name: entry.name,
      path
    };

    children.push(fileNode);
    files.push(fileNode);
    fileContents.set(path, {
      path,
      name: entry.name,
      entries
    });

    for (const property of entries) {
      const bucketKey = `${entry.name}::${property.key}`;
      if (!suggestionIndex.has(bucketKey)) {
        suggestionIndex.set(bucketKey, new Set());
      }

      suggestionIndex.get(bucketKey).add(property.value);
    }
  }

  children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  return {
    tree: {
      type: "directory",
      name: directoryHandle.name,
      path: segments.join("/") || ".",
      children
    },
    files,
    fileContents,
    suggestionIndex
  };
}

function enrichClientFile(fileRecord, suggestionIndex) {
  return {
    ...fileRecord,
    entries: fileRecord.entries.map((entry) => {
      const bucketKey = `${fileRecord.name}::${entry.key}`;
      const suggestions = Array.from(suggestionIndex.get(bucketKey) || []);
      suggestions.sort((a, b) => a.localeCompare(b));

      return {
        ...entry,
        suggestions
      };
    }),
    propertyCount: fileRecord.entries.length
  };
}

function sortEntriesForDisplay(entries = []) {
  return [...entries].sort((left, right) => {
    const keyCompare = left.key.localeCompare(right.key);

    if (keyCompare !== 0) {
      return keyCompare;
    }

    return (left.lineNumber || 0) - (right.lineNumber || 0);
  });
}

function getEntryId(entry, index = 0) {
  return `${entry.key}::${entry.lineNumber ?? index}`;
}

function applyOverridesToEntries(entries = [], overrides = {}) {
  return entries.map((entry, index) => {
    const entryId = getEntryId(entry, index);

    if (!(entryId in overrides)) {
      return entry;
    }

    return {
      ...entry,
      value: overrides[entryId]
    };
  });
}

function buildPropertiesText(entries = []) {
  return sortEntriesForDisplay(entries)
    .map((entry) => `${entry.key}=${entry.value ?? ""}`)
    .join("\n");
}

function filterTree(node, query) {
  if (!node) {
    return null;
  }

  if (!query) {
    return node;
  }

  const normalizedQuery = query.toLowerCase();
  const nodeLabel = `${node.name} ${node.path}`.toLowerCase();

  if (node.type === "file") {
    return nodeLabel.includes(normalizedQuery) ? node : null;
  }

  const filteredChildren = (node.children || [])
    .map((child) => filterTree(child, query))
    .filter(Boolean);

  if (nodeLabel.includes(normalizedQuery) || filteredChildren.length > 0) {
    return {
      ...node,
      children: filteredChildren
    };
  }

  return null;
}

function TreeNode({ node, level = 0, selectedPath, onSelect }) {
  const [expanded, setExpanded] = useState(level < 1);

  if (node.type === "file") {
    return (
      <button
        className={`tree-file ${selectedPath === node.path ? "selected" : ""}`}
        onClick={() => onSelect(node.path)}
        style={{ paddingLeft: `${level * 14 + 16}px` }}
        type="button"
      >
        <span className="tree-icon">F</span>
        <span className="tree-label">{node.name}</span>
      </button>
    );
  }

  return (
    <div className="tree-group">
      <button
        className="tree-directory"
        onClick={() => setExpanded((current) => !current)}
        style={{ paddingLeft: `${level * 14 + 10}px` }}
        type="button"
      >
        <span className="tree-icon">{expanded ? "-" : "+"}</span>
        <span className="tree-label">{node.name}</span>
      </button>
      {expanded &&
        (node.children || []).map((child) => (
          <TreeNode
            key={child.path}
            level={level + 1}
            node={child}
            onSelect={onSelect}
            selectedPath={selectedPath}
          />
        ))}
    </div>
  );
}

function CompareTreeNode({
  node,
  level = 0,
  onSelect,
  searchActive,
  selectedPath
}) {
  const [expanded, setExpanded] = useState(level < 1);
  const isExpanded = searchActive ? true : expanded;

  if (node.type === "file") {
    return (
      <button
        className={`compare-tree-file ${selectedPath === node.path ? "selected" : ""}`}
        onClick={() => onSelect(node.path)}
        style={{ paddingLeft: `${level * 14 + 16}px` }}
        type="button"
      >
        <span className="tree-icon">F</span>
        <span className="compare-tree-text">
          <span className="compare-tree-name">{node.name}</span>
          <span className="compare-tree-path">{node.path}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="tree-group">
      <button
        className="compare-tree-directory"
        onClick={() => setExpanded((current) => !current)}
        style={{ paddingLeft: `${level * 14 + 10}px` }}
        type="button"
      >
        <span className="tree-icon">{isExpanded ? "-" : "+"}</span>
        <span className="tree-label">{node.name}</span>
      </button>
      {isExpanded &&
        (node.children || []).map((child) => (
          <CompareTreeNode
            key={child.path}
            level={level + 1}
            node={child}
            onSelect={onSelect}
            searchActive={searchActive}
            selectedPath={selectedPath}
          />
        ))}
    </div>
  );
}

function CompareFilePicker({ label, onChange, selectedPath, tree }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filteredTree = useMemo(() => filterTree(tree, search), [tree, search]);

  function handleSelect(path) {
    onChange(path);
    setOpen(false);
  }

  return (
    <div className="picker-shell">
      <span className="picker-label">{label}</span>
      <button
        className="picker-trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{selectedPath || "Select a file"}</span>
        <span>{open ? "Close" : "Browse"}</span>
      </button>

      {open && (
        <div className="picker-panel">
          <input
            className="picker-search"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by file or path"
            type="text"
            value={search}
          />
          <div className="picker-tree-scroll">
            {filteredTree ? (
              <CompareTreeNode
                node={filteredTree}
                onSelect={handleSelect}
                searchActive={Boolean(search)}
                selectedPath={selectedPath}
              />
            ) : (
              <p className="empty-copy">No matching files found.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileTree({ tree, selectedPath, onSelect, onRefresh, refreshing }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Config Explorer</h1>
        </div>
        <button className="ghost-button" onClick={onRefresh} type="button">
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <div className="tree-scroll">
        {tree ? (
          <TreeNode node={tree} selectedPath={selectedPath} onSelect={onSelect} />
        ) : (
          <p className="empty-copy">Loading folder tree...</p>
        )}
      </div>
    </aside>
  );
}

function IntroScreen({
  folderSelectionStage,
  currentScanRoot,
  pendingFolderName,
  onChooseFolder,
  onUseCurrentFolder,
  treeReady,
  error
}) {
  const folderSelectionBusy = folderSelectionStage !== "idle";
  const folderButtonLabel =
    folderSelectionStage === "scanning"
      ? "Scanning folder..."
      : folderSelectionStage === "picking"
        ? "Opening picker..."
        : "Choose a different folder";
  const loadingMessage =
    folderSelectionStage === "scanning"
      ? `Scanning ${pendingFolderName || "selected folder"} for .properties files...`
      : "Waiting for your browser's folder picker to open...";

  return (
    <div className="intro-screen">
      <div className="intro-card">
        <p className="eyebrow">Welcome</p>
        <h1>Choose the parent properties folder</h1>
        <p className="hero-note">
          This app is read-only. It scans a folder tree, discovers `.properties` files,
          and helps developers inspect valid keys and compare environments without
          editing live values.
        </p>
        <div className="intro-root-box">
          <span className="intro-root-label">Current detected folder</span>
          <code>{pendingFolderName || currentScanRoot || "Loading..."}</code>
        </div>
        {error && <div className="panel-shell error-box">{error}</div>}
        <div className="intro-actions">
          <button
            className="mode-primary"
            disabled={!treeReady || folderSelectionBusy}
            onClick={onUseCurrentFolder}
            type="button"
          >
            Use this folder
          </button>
          <button
            aria-busy={folderSelectionBusy}
            className={`ghost-button ${folderSelectionBusy ? "loading-button" : ""}`}
            disabled={folderSelectionBusy}
            onClick={onChooseFolder}
            type="button"
          >
            {folderSelectionBusy && <span aria-hidden="true" className="inline-spinner" />}
            <span>{folderButtonLabel}</span>
          </button>
        </div>
        {folderSelectionBusy && (
          <div aria-live="polite" className="intro-loading-note" role="status">
            <span aria-hidden="true" className="inline-spinner" />
            <span>{loadingMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function InspectView({
  fileData,
  loading,
  error,
  onCopyProperties,
  onEntryValueChange
}) {
  if (loading) {
    return <div className="panel-shell">Loading file details...</div>;
  }

  if (error) {
    return <div className="panel-shell error-box">{error}</div>;
  }

  if (!fileData) {
    return (
      <div className="panel-shell">
        Select a property file from the left to explore its keys and known values.
      </div>
    );
  }

  const sortedEntries = sortEntriesForDisplay(fileData.entries);

  return (
    <div className="content-stack">
      <section className="hero-card">
        <div className="card-topline">
          <div>
            <p className="eyebrow">Inspect</p>
            <h2>{fileData.name}</h2>
            <p className="hero-path">{fileData.path}</p>
          </div>
          <button
            className="ghost-button"
            onClick={() => onCopyProperties(fileData.path, sortedEntries)}
            type="button"
          >
            Copy Properties
          </button>
        </div>
        <p className="hero-note">
          This view never writes back to disk. The selected value is the current file
          value, and the menu shows other values seen in matching files with the same
          name and property key.
        </p>
      </section>

      <section className="property-table">
        <div className="property-table-header">
          <span>Property</span>
          <span>Current value and known options</span>
        </div>
        {sortedEntries.map((entry, index) => (
          <div className="property-row" key={`${entry.key}-${entry.lineNumber || index}`}>
            <div>
              <div className="property-key">{entry.key}</div>
              <div className="property-meta">Line {entry.lineNumber}</div>
            </div>
            <div className="property-value-cell">
              <select
                className="value-select"
                onChange={(event) =>
                  onEntryValueChange(fileData.path, entry, event.target.value, index)
                }
                value={entry.value}
              >
                {entry.suggestions.map((suggestion) => (
                  <option key={suggestion || "__empty"} value={suggestion}>
                    {suggestion || "(empty)"}
                  </option>
                ))}
              </select>
              <div className="value-caption">
                {entry.suggestions.length} known value
                {entry.suggestions.length === 1 ? "" : "s"}
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function CompareColumn({
  title,
  data,
  onlyHere,
  missingHere,
  onCopyProperties,
  onEntryValueChange,
  valueDifferences,
  side
}) {
  const ownValueKey = side === "left" ? "leftValue" : "rightValue";
  const otherValueKey = side === "left" ? "rightValue" : "leftValue";
  const sortedEntries = sortEntriesForDisplay(data?.entries || []);
  const sortedOnlyHere = sortEntriesForDisplay(onlyHere);
  const sortedMissingHere = sortEntriesForDisplay(missingHere);
  const sortedValueDifferences = [...valueDifferences].sort((left, right) =>
    left.key.localeCompare(right.key)
  );

  return (
    <div className="compare-column">
      <section className="compare-card">
        <div className="card-topline">
          <div>
            <p className="eyebrow">Selected file</p>
            <h3>{title || "Choose a file"}</h3>
          </div>
          <button
            className="ghost-button"
            disabled={!sortedEntries.length}
            onClick={() => onCopyProperties(title, sortedEntries)}
            type="button"
          >
            Copy Properties
          </button>
        </div>
        <div className="compare-table">
          <div className="compare-table-header">
            <span>Property</span>
            <span>Value</span>
          </div>
          {sortedEntries.length ? (
            sortedEntries.map((entry, index) => {
              const mismatch = valueDifferences.find((item) => item.key === entry.key);
              return (
                <div
                  className={`compare-row ${mismatch ? "mismatch" : ""}`}
                  key={`${title}-${entry.key}-${entry.lineNumber || index}`}
                >
                  <span className="property-key">{entry.key}</span>
                  <div className="property-value-cell">
                    <select
                      className="value-select"
                      onChange={(event) =>
                        onEntryValueChange(title, entry, event.target.value, index)
                      }
                      value={entry.value}
                    >
                      {(entry.suggestions?.length ? entry.suggestions : [entry.value]).map(
                        (suggestion) => (
                          <option key={suggestion || "__empty"} value={suggestion}>
                            {suggestion || "(empty)"}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-copy">No file selected.</div>
          )}
        </div>
      </section>

      <section className="compare-summary-grid">
        <div className="summary-card">
          <h4>Has that the other file does not</h4>
          {sortedOnlyHere.length ? (
            sortedOnlyHere.map((entry, index) => (
              <div className="summary-item" key={`only-${title}-${entry.key}-${index}`}>
                <span className="property-key">{entry.key}</span>
                <span>{entry.value || "(empty)"}</span>
              </div>
            ))
          ) : (
            <p className="empty-copy">No unique properties.</p>
          )}
        </div>

        <div className="summary-card">
          <h4>Does not have that the other file does</h4>
          {sortedMissingHere.length ? (
            sortedMissingHere.map((entry, index) => (
              <div className="summary-item" key={`missing-${title}-${entry.key}-${index}`}>
                <span className="property-key">{entry.key}</span>
                <span>{entry.value || "(empty)"}</span>
              </div>
            ))
          ) : (
            <p className="empty-copy">No missing properties.</p>
          )}
        </div>

        <div className="summary-card summary-wide">
          <h4>Same property, different value</h4>
          {sortedValueDifferences.length ? (
            sortedValueDifferences.map((entry, index) => (
              <div className="summary-item" key={`diff-${title}-${entry.key}-${index}`}>
                <span className="property-key">{entry.key}</span>
                <span>
                  This file: {entry[ownValueKey] || "(empty)"} | Other file:{" "}
                  {entry[otherValueKey] || "(empty)"}
                </span>
              </div>
            ))
          ) : (
            <p className="empty-copy">No differing shared values.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function CompareView({
  tree,
  compareState,
  setCompareState,
  compareData,
  loading,
  error,
  onCopyProperties,
  onEntryValueChange
}) {
  return (
    <div className="content-stack">
      <section className="hero-card">
        <p className="eyebrow">Compare</p>
        <h2>Split-view property comparison</h2>
        <p className="hero-note">
          Pick any two matching property files and compare keys, missing properties, and
          differing values side by side.
        </p>
      </section>

      <section className="compare-pickers">
        <CompareFilePicker
          label="Left file"
          onChange={(path) =>
            setCompareState((current) => ({ ...current, left: path }))
          }
          selectedPath={compareState.left}
          tree={tree}
        />
        <CompareFilePicker
          label="Right file"
          onChange={(path) =>
            setCompareState((current) => ({ ...current, right: path }))
          }
          selectedPath={compareState.right}
          tree={tree}
        />
      </section>

      {loading && <div className="panel-shell">Loading comparison...</div>}
      {error && <div className="panel-shell error-box">{error}</div>}

      {!loading && !error && compareData && (
        <section className="compare-grid">
          <CompareColumn
            data={compareData.left}
            missingHere={compareData.diff.rightOnly}
            onlyHere={compareData.diff.leftOnly}
            onCopyProperties={onCopyProperties}
            onEntryValueChange={onEntryValueChange}
            side="left"
            title={compareData.left.path}
            valueDifferences={compareData.diff.valueDifferences}
          />
          <CompareColumn
            data={compareData.right}
            missingHere={compareData.diff.leftOnly}
            onlyHere={compareData.diff.rightOnly}
            onCopyProperties={onCopyProperties}
            onEntryValueChange={onEntryValueChange}
            side="right"
            title={compareData.right.path}
            valueDifferences={compareData.diff.valueDifferences}
          />
        </section>
      )}
    </div>
  );
}

function ReporterView({
  environmentOptions,
  error,
  loading,
  onRunReport,
  reportData,
  reporterState,
  setReporterState
}) {
  const canRunReport =
    reporterState.left &&
    reporterState.right &&
    reporterState.left !== reporterState.right &&
    !loading;

  return (
    <div className="content-stack">
      <section className="hero-card">
        <p className="eyebrow">Reporter</p>
        <h2>Environment difference report</h2>
        <p className="hero-note">
          Choose two environments to compare matching property files across the full
          folder tree and surface the differences that could explain a misconfiguration.
        </p>
      </section>

      <section className="reporter-toolbar">
        <div className="picker-shell">
          <span className="picker-label">Environment A</span>
          <select
            className="value-select"
            onChange={(event) =>
              setReporterState((current) => ({ ...current, left: event.target.value }))
            }
            value={reporterState.left}
          >
            <option value="">Select an environment</option>
            {environmentOptions.map((environment) => (
              <option key={`left-${environment}`} value={environment}>
                {environment}
              </option>
            ))}
          </select>
        </div>

        <div className="picker-shell">
          <span className="picker-label">Environment B</span>
          <select
            className="value-select"
            onChange={(event) =>
              setReporterState((current) => ({ ...current, right: event.target.value }))
            }
            value={reporterState.right}
          >
            <option value="">Select an environment</option>
            {environmentOptions.map((environment) => (
              <option key={`right-${environment}`} value={environment}>
                {environment}
              </option>
            ))}
          </select>
        </div>

        <button
          className="mode-primary"
          disabled={!canRunReport}
          onClick={onRunReport}
          type="button"
        >
          {loading ? "Building report..." : "Report Differences"}
        </button>
      </section>

      {reporterState.left &&
        reporterState.right &&
        reporterState.left === reporterState.right && (
          <div className="panel-shell error-box">
            Choose two different environments to build a report.
          </div>
        )}

      {loading && <div className="panel-shell">Building environment report...</div>}
      {error && <div className="panel-shell error-box">{error}</div>}

      {!loading && !error && reportData && (
        <>
          <section className="report-summary-grid">
            <div className="summary-card">
              <h4>Changed files</h4>
              <p className="report-stat">{reportData.summary.changedFileCount}</p>
              <p className="empty-copy">
                Matching files with missing keys or different values.
              </p>
            </div>
            <div className="summary-card">
              <h4>{reportData.leftEnvironment} only</h4>
              <p className="report-stat">{reportData.summary.leftOnlyFileCount}</p>
              <p className="empty-copy">Files present only in the left environment.</p>
            </div>
            <div className="summary-card">
              <h4>{reportData.rightEnvironment} only</h4>
              <p className="report-stat">{reportData.summary.rightOnlyFileCount}</p>
              <p className="empty-copy">Files present only in the right environment.</p>
            </div>
          </section>

          {!reportData.files.length &&
            !reportData.leftOnlyFiles.length &&
            !reportData.rightOnlyFiles.length && (
              <div className="panel-shell">
                No differences were found between these environments.
              </div>
            )}

          {Boolean(reportData.leftOnlyFiles.length || reportData.rightOnlyFiles.length) && (
            <section className="compare-summary-grid">
              <div className="summary-card">
                <h4>Files only in {reportData.leftEnvironment}</h4>
                {reportData.leftOnlyFiles.length ? (
                  reportData.leftOnlyFiles.map((file) => (
                    <div className="summary-item" key={`left-only-${file.relativePath}`}>
                      <span className="property-key">{file.fileName}</span>
                      <span>{file.relativePath}</span>
                    </div>
                  ))
                ) : (
                  <p className="empty-copy">No environment-specific files.</p>
                )}
              </div>

              <div className="summary-card">
                <h4>Files only in {reportData.rightEnvironment}</h4>
                {reportData.rightOnlyFiles.length ? (
                  reportData.rightOnlyFiles.map((file) => (
                    <div className="summary-item" key={`right-only-${file.relativePath}`}>
                      <span className="property-key">{file.fileName}</span>
                      <span>{file.relativePath}</span>
                    </div>
                  ))
                ) : (
                  <p className="empty-copy">No environment-specific files.</p>
                )}
              </div>
            </section>
          )}

          {reportData.files.map((file) => (
            <section className="report-card" key={file.relativePath}>
              <div className="card-topline">
                <div>
                  <p className="eyebrow">Changed file</p>
                  <h3>{file.fileName}</h3>
                  <p className="hero-path">{file.relativePath}</p>
                </div>
              </div>

              <div className="report-diff-grid">
                <div className="summary-card">
                  <h4>Only in {reportData.leftEnvironment}</h4>
                  {file.diff.leftOnly.length ? (
                    file.diff.leftOnly.map((entry) => (
                      <div
                        className="summary-item"
                        key={`${file.relativePath}-left-only-${entry.key}`}
                      >
                        <span className="property-key">{entry.key}</span>
                        <span>{entry.value || "(empty)"}</span>
                      </div>
                    ))
                  ) : (
                    <p className="empty-copy">No unique properties.</p>
                  )}
                </div>

                <div className="summary-card">
                  <h4>Only in {reportData.rightEnvironment}</h4>
                  {file.diff.rightOnly.length ? (
                    file.diff.rightOnly.map((entry) => (
                      <div
                        className="summary-item"
                        key={`${file.relativePath}-right-only-${entry.key}`}
                      >
                        <span className="property-key">{entry.key}</span>
                        <span>{entry.value || "(empty)"}</span>
                      </div>
                    ))
                  ) : (
                    <p className="empty-copy">No unique properties.</p>
                  )}
                </div>

                <div className="summary-card summary-wide">
                  <h4>Different values</h4>
                  {file.diff.valueDifferences.length ? (
                    file.diff.valueDifferences.map((entry) => (
                      <div
                        className="summary-item"
                        key={`${file.relativePath}-diff-${entry.key}`}
                      >
                        <span className="property-key">{entry.key}</span>
                        <span>
                          {reportData.leftEnvironment}: {entry.leftValue || "(empty)"} |{" "}
                          {reportData.rightEnvironment}: {entry.rightValue || "(empty)"}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="empty-copy">No differing shared values.</p>
                  )}
                </div>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function GuideModal({ onClose }) {
  const sections = [
    {
      title: "Getting started",
      body:
        "When the app opens, choose the current detected folder or pick a different parent folder. The app only reads files and never writes changes back to disk."
    },
    {
      title: "Inspect view",
      body:
        "Use Inspect to browse one property file at a time. The left sidebar shows the folder tree. When you open a file, the properties are displayed alphabetically, and each value menu shows other known values found in matching files with the same filename and property key."
    },
    {
      title: "Compare view",
      body:
        "Use Compare to pick two property files and review them side by side. The file pickers are searchable tree browsers. Each side shows the selected file, properties unique to that file, properties missing from that file, and shared properties whose values differ."
    },
    {
      title: "Reporter view",
      body:
        "Use Reporter to compare two environments at once. The report matches files by their shared path inside each environment folder and highlights missing files, missing keys, and different values."
    },
    {
      title: "Refresh and folder changes",
      body:
        "Use Refresh after external file changes so the app rescans the current folder. Use Change Folder any time you want to switch to a different parent config folder."
    },
    {
      title: "What counts as read-only",
      body:
        "This tool is meant to guide developers, not edit environments. Sorting and compare results affect only the display inside the app. Your underlying property files are not modified."
    }
  ];

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        aria-labelledby="guide-title"
        aria-modal="true"
        className="guide-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="guide-header">
          <div>
            <p className="eyebrow">User Guide</p>
            <h2 id="guide-title">How to use Config Explorer</h2>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div className="guide-sections">
          {sections.map((section, index) => (
            <details className="guide-section" key={section.title} open={index === 0}>
              <summary>{section.title}</summary>
              <p>{section.body}</p>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

function Toast({ message }) {
  return (
    <div aria-live="polite" className="toast" role="status">
      {message}
    </div>
  );
}

export default function App() {
  const [treeData, setTreeData] = useState(null);
  const [allFiles, setAllFiles] = useState([]);
  const [scanRoot, setScanRoot] = useState("");
  const [dataSource, setDataSource] = useState("server");
  const [clientData, setClientData] = useState(null);
  const [selectedDirectoryHandle, setSelectedDirectoryHandle] = useState(null);
  const [valueOverrides, setValueOverrides] = useState({});
  const [selectedPath, setSelectedPath] = useState("");
  const [fileData, setFileData] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState("inspect");
  const [compareState, setCompareState] = useState({ left: "", right: "" });
  const [compareData, setCompareData] = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState("");
  const [reporterState, setReporterState] = useState({ left: "", right: "" });
  const [reporterData, setReporterData] = useState(null);
  const [reporterLoading, setReporterLoading] = useState(false);
  const [reporterError, setReporterError] = useState("");
  const [showIntro, setShowIntro] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const [folderSelectionStage, setFolderSelectionStage] = useState("idle");
  const [pendingFolderName, setPendingFolderName] = useState("");
  const [startupError, setStartupError] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const environmentOptions = useMemo(() => collectEnvironmentOptions(allFiles), [allFiles]);

  useEffect(() => {
    if (environmentOptions.length < 2) {
      setReporterState({ left: environmentOptions[0] || "", right: "" });
      setReporterData(null);
      setReporterError("");
      return;
    }

    setReporterState((current) => {
      const safeLeft = environmentOptions.includes(current.left)
        ? current.left
        : environmentOptions[0];
      const currentRightValid =
        current.right && current.right !== safeLeft && environmentOptions.includes(current.right);
      const safeRight = currentRightValid
        ? current.right
        : environmentOptions.find((environment) => environment !== safeLeft) || "";

      if (safeLeft === current.left && safeRight === current.right) {
        return current;
      }

      return {
        left: safeLeft,
        right: safeRight
      };
    });
    setReporterData(null);
    setReporterError("");
  }, [environmentOptions]);

  useEffect(() => {
    fetch("/api/tree")
      .then((response) => response.json())
      .then((data) => {
        setTreeData(data.tree);
        setAllFiles(data.files || []);
        setScanRoot(data.scanRoot || "");
        setDataSource("server");
        const firstFile = data.files[0]?.path || "";
        setSelectedPath(firstFile);
        setCompareState((current) => ({
          left: current.left || firstFile,
          right: current.right || data.files[1]?.path || firstFile
        }));
        setValueOverrides({});
        setStartupError("");
      })
      .catch((error) => {
        setStartupError(error.message);
      });
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    if (dataSource === "client" && clientData) {
      const fileRecord = clientData.fileContents.get(selectedPath);

      if (!fileRecord) {
        setFileError("The selected file could not be found in the chosen folder.");
        return;
      }

      setFileLoading(true);
      setFileError("");
      setFileData(
        enrichClientFile(
          {
            ...fileRecord,
            entries: applyOverridesToEntries(
              fileRecord.entries,
              valueOverrides[selectedPath] || {}
            )
          },
          clientData.suggestionIndex
        )
      );
      setFileLoading(false);
      return;
    }

    setFileLoading(true);
    setFileError("");

    fetch(`/api/file?path=${encodeURIComponent(selectedPath)}`)
      .then((response) => response.json())
      .then((data) => {
        if (data.error) {
          throw new Error(data.error);
        }
        setFileData({
          ...data,
          entries: applyOverridesToEntries(data.entries, valueOverrides[selectedPath] || {})
        });
      })
      .catch((error) => {
        setFileError(error.message);
      })
      .finally(() => {
        setFileLoading(false);
      });
  }, [clientData, dataSource, selectedPath, valueOverrides]);

  useEffect(() => {
    if (!compareState.left || !compareState.right) {
      return;
    }

    if (dataSource === "client" && clientData) {
      const left = clientData.fileContents.get(compareState.left);
      const right = clientData.fileContents.get(compareState.right);

      if (!left || !right) {
        setCompareError("One or both selected files could not be found.");
        return;
      }

      setCompareLoading(true);
      setCompareError("");
      const leftEntries = applyOverridesToEntries(
        left.entries,
        valueOverrides[left.path] || {}
      );
      const rightEntries = applyOverridesToEntries(
        right.entries,
        valueOverrides[right.path] || {}
      );
      setCompareData({
        left: enrichClientFile(
          {
            ...left,
            entries: leftEntries
          },
          clientData.suggestionIndex
        ),
        right: enrichClientFile(
          {
            ...right,
            entries: rightEntries
          },
          clientData.suggestionIndex
        ),
        diff: comparePropertiesData(leftEntries, rightEntries)
      });
      setCompareLoading(false);
      return;
    }

    setCompareLoading(true);
    setCompareError("");

    fetch(
      `/api/compare?left=${encodeURIComponent(compareState.left)}&right=${encodeURIComponent(
        compareState.right
      )}`
    )
      .then((response) => response.json())
      .then((data) => {
        if (data.error) {
          throw new Error(data.error);
        }
        const leftEntries = applyOverridesToEntries(
          data.left.entries,
          valueOverrides[data.left.path] || {}
        );
        const rightEntries = applyOverridesToEntries(
          data.right.entries,
          valueOverrides[data.right.path] || {}
        );

        setCompareData({
          ...data,
          left: {
            ...data.left,
            entries: leftEntries
          },
          right: {
            ...data.right,
            entries: rightEntries
          },
          diff: comparePropertiesData(leftEntries, rightEntries)
        });
      })
      .catch((error) => {
        setCompareError(error.message);
      })
      .finally(() => {
        setCompareLoading(false);
      });
  }, [clientData, compareState.left, compareState.right, dataSource, valueOverrides]);

  function handleEntryValueChange(filePath, entry, nextValue, index = 0) {
    const entryId = getEntryId(entry, index);

    setValueOverrides((current) => ({
      ...current,
      [filePath]: {
        ...(current[filePath] || {}),
        [entryId]: nextValue
      }
    }));
  }

  async function handleCopyProperties(filePath, entries) {
    try {
      await navigator.clipboard.writeText(buildPropertiesText(entries));
      setStartupError("");
      setToastMessage(`Copied properties from ${filePath}`);
    } catch (error) {
      setStartupError(
        `Unable to copy properties for ${filePath}. ${error?.message || ""}`.trim()
      );
    }
  }

  useEffect(() => {
    if (!toastMessage) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setToastMessage("");
    }, 2200);

    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  function handleRefresh() {
    if (dataSource === "client" && selectedDirectoryHandle) {
      setRefreshing(true);
      setStartupError("");

      scanDirectoryHandle(selectedDirectoryHandle)
        .then((scanned) => {
          setTreeData(scanned.tree);
          setAllFiles(scanned.files);
          setClientData({
            fileContents: scanned.fileContents,
            suggestionIndex: scanned.suggestionIndex
          });
          setSelectedPath((current) =>
            scanned.fileContents.has(current) ? current : scanned.files[0]?.path || ""
          );
          setCompareState((current) => ({
            left: scanned.fileContents.has(current.left)
              ? current.left
              : scanned.files[0]?.path || "",
            right: scanned.fileContents.has(current.right)
              ? current.right
              : scanned.files[1]?.path || scanned.files[0]?.path || ""
          }));
        })
        .catch((error) => {
          setStartupError(error.message || "Unable to refresh the selected folder.");
        })
        .finally(() => {
          setRefreshing(false);
        });
      return;
    }

    setRefreshing(true);
    fetch("/api/refresh", { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        setTreeData(data.tree);
        setAllFiles(data.files || []);
        setScanRoot(data.scanRoot || "");
        setValueOverrides({});
      })
      .finally(() => {
        setRefreshing(false);
      });
  }

  function handleChooseFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      setStartupError("This browser does not support folder picking. Please use a Chromium-based browser.");
      return;
    }

    setFolderSelectionStage("picking");
    setPendingFolderName("");
    setStartupError("");

    window
      .showDirectoryPicker()
      .then(async (directoryHandle) => {
        setFolderSelectionStage("scanning");
        setPendingFolderName(directoryHandle.name);
        const scanned = await scanDirectoryHandle(directoryHandle);

        setTreeData(scanned.tree);
        setAllFiles(scanned.files);
        setScanRoot(directoryHandle.name);
        setDataSource("client");
        setSelectedDirectoryHandle(directoryHandle);
        setClientData({
          fileContents: scanned.fileContents,
          suggestionIndex: scanned.suggestionIndex
        });
        setValueOverrides({});

        const firstFile = scanned.files[0]?.path || "";
        setSelectedPath(firstFile);
        setCompareState({
          left: scanned.files[0]?.path || "",
          right: scanned.files[1]?.path || scanned.files[0]?.path || ""
        });
        setFileData(null);
        setCompareData(null);
        setFileError("");
        setCompareError("");
        setShowIntro(false);
      })
      .catch((error) => {
        if (error?.name === "AbortError") {
          return;
        }

        setStartupError(error.message || "Unable to open the selected folder.");
      })
      .finally(() => {
        setFolderSelectionStage("idle");
        setPendingFolderName("");
      });
  }

  function handleUseCurrentFolder() {
    setShowIntro(false);
  }

  function handleChangeFolder() {
    setShowIntro(true);
  }

  function handleRunReporter() {
    if (
      !reporterState.left ||
      !reporterState.right ||
      reporterState.left === reporterState.right
    ) {
      return;
    }

    setReporterLoading(true);
    setReporterError("");

    if (dataSource === "client" && clientData) {
      try {
        const report = buildReporterData(
          Array.from(clientData.fileContents.values()),
          reporterState.left,
          reporterState.right
        );
        setReporterData(report);
      } catch (error) {
        setReporterError(error.message || "Unable to build the environment report.");
      } finally {
        setReporterLoading(false);
      }

      return;
    }

    fetch(
      `/api/report?leftEnvironment=${encodeURIComponent(
        reporterState.left
      )}&rightEnvironment=${encodeURIComponent(reporterState.right)}`
    )
      .then((response) => response.json())
      .then((data) => {
        if (data.error) {
          throw new Error(data.error);
        }

        setReporterData(data);
      })
      .catch((error) => {
        setReporterError(error.message || "Unable to build the environment report.");
      })
      .finally(() => {
        setReporterLoading(false);
      });
  }

  if (showIntro) {
    return (
      <IntroScreen
        currentScanRoot={scanRoot}
        error={startupError}
        folderSelectionStage={folderSelectionStage}
        onChooseFolder={handleChooseFolder}
        onUseCurrentFolder={handleUseCurrentFolder}
        pendingFolderName={pendingFolderName}
        treeReady={Boolean(treeData)}
      />
    );
  }

  return (
    <>
      <div className="app-shell">
        <FileTree
          tree={treeData}
          selectedPath={selectedPath}
          onRefresh={handleRefresh}
          onSelect={setSelectedPath}
          refreshing={refreshing}
        />

        <main className="main-panel">
          <header className="topbar">
            <div>
              <p className="eyebrow">Read-only guide</p>
              <h2>Environment property navigator</h2>
              <p className="hero-path">{scanRoot}</p>
            </div>
            <div className="mode-switch">
              <button onClick={() => setShowGuide(true)} type="button">
                User Guide
              </button>
              <button
                className={mode === "reporter" ? "active" : ""}
                onClick={() => setMode("reporter")}
                type="button"
              >
                Reporter
              </button>
              <button onClick={handleChangeFolder} type="button">
                Change Folder
              </button>
              <button
                className={mode === "inspect" ? "active" : ""}
                onClick={() => setMode("inspect")}
                type="button"
              >
                Inspect
              </button>
              <button
                className={mode === "compare" ? "active" : ""}
                onClick={() => setMode("compare")}
                type="button"
              >
                Compare
              </button>
            </div>
          </header>

          {startupError && <div className="panel-shell error-box">{startupError}</div>}

          {mode === "inspect" ? (
            <InspectView
              error={fileError}
              fileData={fileData}
              loading={fileLoading}
              onCopyProperties={handleCopyProperties}
              onEntryValueChange={handleEntryValueChange}
            />
          ) : mode === "compare" ? (
            <CompareView
              compareData={compareData}
              compareState={compareState}
              error={compareError}
              loading={compareLoading}
              onCopyProperties={handleCopyProperties}
              onEntryValueChange={handleEntryValueChange}
              setCompareState={setCompareState}
              tree={treeData}
            />
          ) : (
            <ReporterView
              environmentOptions={environmentOptions}
              error={reporterError}
              loading={reporterLoading}
              onRunReport={handleRunReporter}
              reportData={reporterData}
              reporterState={reporterState}
              setReporterState={setReporterState}
            />
          )}
        </main>
      </div>

      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
      {toastMessage && <Toast message={toastMessage} />}
    </>
  );
}
