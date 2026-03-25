import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const defaultScanRoot = path.resolve(appRoot, "..");
const initialScanRoot = process.env.SCAN_ROOT
  ? path.resolve(process.env.SCAN_ROOT)
  : defaultScanRoot;
const PORT = Number(process.env.PORT || 4177);
let scanRoot = initialScanRoot;

const allowedExtensions = new Set([".properties"]);
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "config-explorer"
]);

function normalizeForClient(fullPath) {
  return path.relative(scanRoot, fullPath).split(path.sep).join("/");
}

function getPathSegments(clientPath = "") {
  return clientPath.split("/").filter(Boolean).filter((segment) => segment !== ".");
}

function getEnvironmentName(clientPath) {
  const segments = getPathSegments(clientPath);

  if (segments.length < 2) {
    return "";
  }

  return segments[0];
}

function getEnvironmentRelativePath(clientPath) {
  const segments = getPathSegments(clientPath);

  if (segments.length < 2) {
    return "";
  }

  return segments.slice(1).join("/");
}

function resolveClientPath(clientPath) {
  const resolved = path.resolve(scanRoot, clientPath);
  const relative = path.relative(scanRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the configured scan root.");
  }

  return resolved;
}

function parsePropertyLine(line) {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    return null;
  }

  const separatorIndex = line.search(/\s*[=:]\s*/);

  if (separatorIndex < 0) {
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

function parseProperties(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  const propertyMap = new Map();

  for (const [index, line] of lines.entries()) {
    const parsed = parsePropertyLine(line);

    if (!parsed) {
      continue;
    }

    const entry = {
      key: parsed.key,
      value: parsed.value,
      lineNumber: index + 1
    };

    entries.push(entry);
    propertyMap.set(entry.key, entry.value);
  }

  return {
    entries,
    propertyMap
  };
}

function compareProperties(leftEntries, rightEntries) {
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

function scanDirectory(currentDirectory) {
  const directoryEntries = fs.readdirSync(currentDirectory, { withFileTypes: true });
  const children = [];
  const files = [];

  for (const entry of directoryEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(currentDirectory, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      const scanned = scanDirectory(fullPath);

      if (scanned.tree.children.length > 0) {
        children.push(scanned.tree);
        files.push(...scanned.files);
      }

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    const clientPath = normalizeForClient(fullPath);
    const fileNode = {
      type: "file",
      name: entry.name,
      path: clientPath
    };

    children.push(fileNode);
    files.push(fileNode);
  }

  return {
    tree: {
      type: "directory",
      name: path.basename(currentDirectory),
      path: normalizeForClient(currentDirectory) || ".",
      children
    },
    files
  };
}

function buildIndex() {
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    throw new Error(`Scan root does not exist or is not a directory: ${scanRoot}`);
  }

  const { tree, files } = scanDirectory(scanRoot);
  const suggestionIndex = new Map();

  for (const file of files) {
    const fullPath = resolveClientPath(file.path);
    const content = fs.readFileSync(fullPath, "utf8");
    const { entries } = parseProperties(content);
    const fileName = path.basename(fullPath);

    for (const entry of entries) {
      const bucketKey = `${fileName}::${entry.key}`;
      if (!suggestionIndex.has(bucketKey)) {
        suggestionIndex.set(bucketKey, new Set());
      }

      suggestionIndex.get(bucketKey).add(entry.value);
    }
  }

  return {
    tree,
    files,
    suggestionIndex
  };
}

function buildEnvironmentReport(leftEnvironment, rightEnvironment) {
  const environmentFiles = new Map();

  for (const file of indexCache.files) {
    const environment = getEnvironmentName(file.path);
    const relativePath = getEnvironmentRelativePath(file.path);

    if (!environment || !relativePath) {
      continue;
    }

    if (!environmentFiles.has(environment)) {
      environmentFiles.set(environment, new Map());
    }

    environmentFiles.get(environment).set(relativePath, file);
  }

  const leftFiles = environmentFiles.get(leftEnvironment) || new Map();
  const rightFiles = environmentFiles.get(rightEnvironment) || new Map();
  const allRelativePaths = Array.from(
    new Set([...leftFiles.keys(), ...rightFiles.keys()])
  ).sort((a, b) => a.localeCompare(b));
  const files = [];
  const leftOnlyFiles = [];
  const rightOnlyFiles = [];

  for (const relativePath of allRelativePaths) {
    const leftFile = leftFiles.get(relativePath);
    const rightFile = rightFiles.get(relativePath);

    if (!leftFile) {
      rightOnlyFiles.push({
        relativePath,
        fileName: rightFile?.name || path.basename(relativePath),
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

    const leftEntries = parseProperties(fs.readFileSync(resolveClientPath(leftFile.path), "utf8")).entries;
    const rightEntries = parseProperties(fs.readFileSync(resolveClientPath(rightFile.path), "utf8")).entries;
    const diff = compareProperties(leftEntries, rightEntries);

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

let indexCache = buildIndex();

function refreshIndex() {
  indexCache = buildIndex();
  return indexCache;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(JSON.stringify(payload));
}

function routeRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (requestUrl.pathname === "/api/tree") {
      const { tree, files } = indexCache;
      sendJson(response, 200, {
        tree,
        files,
        scanRoot
      });
      return;
    }

    if (requestUrl.pathname === "/api/refresh" && request.method === "POST") {
      const updated = refreshIndex();
      sendJson(response, 200, {
        tree: updated.tree,
        files: updated.files,
        scanRoot
      });
      return;
    }

    if (requestUrl.pathname === "/api/file") {
      const clientPath = requestUrl.searchParams.get("path");

      if (!clientPath) {
        sendJson(response, 400, { error: "Missing file path." });
        return;
      }

      const fullPath = resolveClientPath(clientPath);
      const fileName = path.basename(fullPath);
      const content = fs.readFileSync(fullPath, "utf8");
      const { entries } = parseProperties(content);

      const enrichedEntries = entries.map((entry) => {
        const bucketKey = `${fileName}::${entry.key}`;
        const suggestions = Array.from(indexCache.suggestionIndex.get(bucketKey) || []);
        suggestions.sort((a, b) => a.localeCompare(b));

        return {
          ...entry,
          suggestions
        };
      });

      sendJson(response, 200, {
        path: clientPath,
        name: fileName,
        entries: enrichedEntries,
        propertyCount: enrichedEntries.length
      });
      return;
    }

    if (requestUrl.pathname === "/api/compare") {
      const left = requestUrl.searchParams.get("left");
      const right = requestUrl.searchParams.get("right");

      if (!left || !right) {
        sendJson(response, 400, { error: "Both compare paths are required." });
        return;
      }

      const leftContent = fs.readFileSync(resolveClientPath(left), "utf8");
      const rightContent = fs.readFileSync(resolveClientPath(right), "utf8");
      const leftParsed = parseProperties(leftContent);
      const rightParsed = parseProperties(rightContent);
      const leftName = path.basename(left);
      const rightName = path.basename(right);
      const leftEntries = leftParsed.entries.map((entry) => {
        const bucketKey = `${leftName}::${entry.key}`;
        const suggestions = Array.from(indexCache.suggestionIndex.get(bucketKey) || []);
        suggestions.sort((a, b) => a.localeCompare(b));

        return {
          ...entry,
          suggestions
        };
      });
      const rightEntries = rightParsed.entries.map((entry) => {
        const bucketKey = `${rightName}::${entry.key}`;
        const suggestions = Array.from(indexCache.suggestionIndex.get(bucketKey) || []);
        suggestions.sort((a, b) => a.localeCompare(b));

        return {
          ...entry,
          suggestions
        };
      });
      const diff = compareProperties(leftEntries, rightEntries);

      sendJson(response, 200, {
        left: {
          path: left,
          entries: leftEntries
        },
        right: {
          path: right,
          entries: rightEntries
        },
        diff
      });
      return;
    }

    if (requestUrl.pathname === "/api/report") {
      const leftEnvironment = requestUrl.searchParams.get("leftEnvironment");
      const rightEnvironment = requestUrl.searchParams.get("rightEnvironment");

      if (!leftEnvironment || !rightEnvironment) {
        sendJson(response, 400, { error: "Both environments are required." });
        return;
      }

      if (leftEnvironment === rightEnvironment) {
        sendJson(response, 400, { error: "Choose two different environments." });
        return;
      }

      sendJson(response, 200, buildEnvironmentReport(leftEnvironment, rightEnvironment));
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 500, {
      error: error.message || "Unknown server error."
    });
  }
}

const server = createServer(routeRequest);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Set PORT to a different value before starting the API.`
    );
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Config Explorer API running on http://localhost:${PORT}`);
  console.log(`Scanning property files from: ${scanRoot}`);
});
