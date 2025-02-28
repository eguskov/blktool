'use strict';
import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import * as fs from 'fs';

import { blk } from './blk-pegjs';

const g_mount_point_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']%(.*)[\"']", 'gi');
const g_absolute_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']#(.*)[\"']", 'gi');
const g_relative_include_pattern = new RegExp("(?:\\binclude\\b)(?:\\s+)[\"']([^#].*)[\"']", 'gi');
const g_include_in_string_pattern = new RegExp("[\"'](.*\.blk)[\"']", 'gi');

let g_out: vscode.OutputChannel = null;

function logLine(line: string)
{
  if (g_out)
    g_out.appendLine(line);
}

function onFileOpenError(reason)
{
  vscode.window.showErrorMessage(reason.message);
}

function getFilename(uri: vscode.Uri | string)
{
  let filePath = uri instanceof vscode.Uri ? (<vscode.Uri>uri).fsPath : uri;
  return path.basename(filePath);
}

function getPath(uri: vscode.Uri | string)
{
  let filePath = uri instanceof vscode.Uri ? (<vscode.Uri>uri).fsPath : uri;
  return filePath.replace(getFilename(uri), '');
}

function getFullPathFromInclude(text: string, root_path: string)
{
  if (!text)
    return null;

  let mpMatch = g_mount_point_include_pattern.exec(text);
  g_mount_point_include_pattern.lastIndex = 0;
  if (mpMatch)
  {
    let conf = vscode.workspace.getConfiguration("blktool");
    let mountPoints = conf.get<{ [key: string]: string }>('mountPoints');

    if (!mountPoints) {
      return null;
    }

    let pathParts = mpMatch[1].replace(/\\/g, '/').split('/');
    let mpName = pathParts[0];
    let mpPath = mountPoints['%' + mpName];
    if (!mpPath) {
      return null;
    }

    return path.normalize(path.join(mpPath, pathParts.slice(1).join('/')));
  }

  let absMatch = g_absolute_include_pattern.exec(text);
  g_absolute_include_pattern.lastIndex = 0;
  if (absMatch)
  {
    let conf = vscode.workspace.getConfiguration("blktool");
    return path.normalize(path.join(conf.get('root'), absMatch[1]));
  }

  let relMatch = g_relative_include_pattern.exec(text);
  g_relative_include_pattern.lastIndex = 0;
  if (relMatch)
  {
    return path.normalize(path.join(root_path, relMatch[1]));
  }

  let strMatch = g_include_in_string_pattern.exec(text);
  g_include_in_string_pattern.lastIndex = 0;
  if (strMatch)
  {
    let conf = vscode.workspace.getConfiguration("blktool");

    let rootPath = path.normalize(path.join(conf.get('root'), 'develop', 'gameBase', strMatch[1]))
    logLine(`Checking: ${rootPath}`);

    if (fs.existsSync(rootPath))
    {
      return rootPath;
    }

    if (strMatch[1].startsWith('%'))
    {
      logLine(`Checking: ${strMatch[1]}`);

      let mountPoints = conf.get<{ [key: string]: string }>('mountPoints');
      if (!mountPoints)
      {
        return null;
      }

      let pathParts = strMatch[1].replace(/\\/g, '/').split('/');
      let mpName = pathParts[0];
      let mpPath = mountPoints['%' + mpName];
      if (!mpPath) {
        mpPath = mountPoints[mpName];
      }
      if (!mpPath) {
        return null;
      }

      return path.normalize(path.join(mpPath, pathParts.slice(1).join('/')));
    }

    let searchDirs: Array<string> = conf.get('searchDirs');
    for (let dir of searchDirs)
    {
      let fullPath = path.normalize(path.join(dir, strMatch[1]));
      logLine(`Checking: ${fullPath}`);

      if (fs.existsSync(fullPath))
      {
        return fullPath;
      }
    }
  }

  return null;
}

let diagnosticCollection: vscode.DiagnosticCollection = null;

function parseBLKErrors(document: vscode.TextDocument, data: string)
{
  var errors = []
  var errorsByLine = {}

  let pushError = function (message: string, lineNum: number)
  {
    if (errorsByLine[lineNum])
      return;

    errorsByLine[lineNum] = true;

    let diagnostic : vscode.Diagnostic = {
      severity: vscode.DiagnosticSeverity.Error,
      range: new vscode.Range(lineNum, 0, lineNum, document.lineAt(lineNum).text.length),
      message: message,
      source: 'blk',
      code: 0
    }
    errors.push(diagnostic);
  };

  data.split('\n').forEach(line => {
    if (line.startsWith('ERR:'))
    {
      // BLK error '%s',%d: %s
      let match = line.match(/ERR: BLK error '(?:.*)',(\d+): (.*)/);
      if (match)
        pushError(match[2], parseInt(match[1]) - 1);

      // BLK invalid %s (type %s) value in line %d of '%s': '%s'
      match = line.match(/ERR: BLK invalid (?:.*) \(type (?:.*)\) value in line (\d+) of '(?:.*)': '(?:.*)'/);
      if (match)
        pushError(match[0].substring('ERR: '.length), parseInt(match[1]) - 1);
    }
  });

  return errors;
}

function validateBlk(document: vscode.TextDocument)
{
  if (!diagnosticCollection)
    return;

  let filename = getFilename(document.fileName);

  if (!filename)
    return;

  let conf = vscode.workspace.getConfiguration("blktool");
  let mountPoints = conf.get<{ [key: string]: string }>('mountPoints');
  let extDir = vscode.extensions.getExtension("eguskov.blktool").extensionPath;
  let fileDir = path.dirname(document.fileName);
  var mountPointsCmd = [];
  for (let key in mountPoints)
  {
    mountPointsCmd.push('-mount:' + key.replace('%', '') + '=' + mountPoints[key]);
  }
  
  child_process.execFile(path.join(extDir, 'binBlk.exe'), [path.basename(document.fileName), '-', '-t', '-h', '-v', '-root:' + conf.get('root'), '-final'].concat(mountPointsCmd), { cwd: fileDir }, function (err, data)
  {
    if (err)
    {
      diagnosticCollection.set(document.uri, parseBLKErrors(document, data));

      vscode.commands.executeCommand('workbench.action.problems.focus');
    }
    else
    {
      diagnosticCollection.clear();
    }
  });
}

export function activate(context: vscode.ExtensionContext)
{
  let out = vscode.window.createOutputChannel("BLKTool");
  out.show(true);

  g_out = out;

  logLine('Welcome to BLK Tool');

  diagnosticCollection = vscode.languages.createDiagnosticCollection('blk');
  context.subscriptions.push(diagnosticCollection);

  blk.setDiagnosticCollection(diagnosticCollection);

  vscode.languages.setLanguageConfiguration('blk', {
    wordPattern: /("(?:[^\\\"]*(?:\\.)?)*"?)|[^\s{}\[\],:]+/,
    indentationRules: {
      increaseIndentPattern: /^.*(\{[^}]*|\[[^\]]*)$/,
      decreaseIndentPattern: /^\s*[}\]],?\s*$/
    }
  });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (document.languageId === 'blk')
    {
      validateBlk(document);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    if (document.languageId === 'blk')
    {
      validateBlk(document);
    }
  }));

  context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider('blk', new blk.RangeFormattingEditProvider));

  context.subscriptions.push(vscode.commands.registerCommand('extension.blktool.openInclude', () =>
  {
    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || document.languageId !== 'blk')
      return;

    let text = document.lineAt(editor.selection.start).text;
    let filePath = getFullPathFromInclude(text, getPath(document.uri));
    if (filePath)
      vscode.workspace.openTextDocument(filePath).then(value => vscode.window.showTextDocument(value, vscode.ViewColumn.Two, false), onFileOpenError);
    else
      vscode.window.showErrorMessage('Include not found');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('extension.blktool.showResultFile', () =>
  {
    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || !document.fileName.endsWith('.blk'))
      return;

    document.save().then(() =>
    {
      let filename = getFilename(document.fileName);

      if (filename)
      {
        let conf = vscode.workspace.getConfiguration("blktool");
        let mountPoints = conf.get<{ [key: string]: string }>('mountPoints');
        let extDir = vscode.extensions.getExtension("eguskov.blktool").extensionPath;
        let fileDir = path.dirname(document.fileName);
        var mountPointsCmd = [];
        for (let key in mountPoints)
        {
          mountPointsCmd.push('-mount:' + key.replace('%', '') + '=' + mountPoints[key]);
        }

        diagnosticCollection.clear();
        
        child_process.execFile(path.join(extDir, 'binBlk.exe'), [path.basename(document.fileName), '-', '-t', '-root:' + conf.get('root'), '-final'].concat(mountPointsCmd), { cwd: fileDir }, function (err, data)
        {
          if (err)
          {
            vscode.window.showErrorMessage(data);

            diagnosticCollection.set(document.uri, parseBLKErrors(document, data));

            vscode.commands.executeCommand('workbench.action.problems.focus');
          }
          else
          {
            vscode.workspace.openTextDocument({language: 'blk'}).then(value => {
              vscode.window.showTextDocument(value, vscode.ViewColumn.Two, false).then(editor => editor.edit(builder => builder.insert(editor.selection.start, data)))
            });
          }
        });
      }
      else
        vscode.window.showErrorMessage('Include not found');
    });

  }));

  let disposable = vscode.commands.registerCommand('extension.blktool.showDependencyTree', async function () {
    // Create and show a new webview panel
    const panel = vscode.window.createWebviewPanel(
      'dependencyTree', // Identifies the type of the webview. Used internally
      'Dependency Tree', // Title of the panel displayed to the user
      vscode.ViewColumn.Two, // Editor column to show the new webview panel in.
      {
        enableScripts: true,  // Enable JavaScript in the webview
        retainContextWhenHidden: true,
      }
    );
    // Set the HTML content of the panel
    panel.webview.html = getWebviewContent();

    let editor = vscode.window.activeTextEditor;
    if (!editor)
      return;

    let document = editor.document;
    if (!document || !document.fileName.endsWith('.blk'))
      return;

    let includes = await blk.getIncludes(document, getFullPathFromInclude);

    // Send the data to the Webview.
    panel.webview.postMessage({ command: 'setData', data: includes });

    panel.webview.onDidReceiveMessage(message => {
      console.log({message});
      // console.log({data: message.data});
      switch (message.command) {
        case 'nodeClicked':
          // vscode.window.showInformationMessage(`Node clicked: ${message.data.name}`);
          break;
        case 'openBLK':
          vscode.workspace.openTextDocument(message.data.value).then(value => vscode.window.showTextDocument(value, vscode.ViewColumn.Two, false), onFileOpenError);
          break;
      }
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate()
{
}

function getWebviewContent(): string
{
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Dependency Tree</title>
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      background-color: #1e1e1e;
      color: #eee;
      font-family: sans-serif;
    }
    /* Container that holds the search box and chart */
    #container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-width: 300px;
      min-height: 300px;
    }
    /* Search box container at the top */
    #search-container {
      padding: 5px;
      background-color: #333;
    }
    #searchInput {
      width: 70%;
      padding: 5px;
      border: none;
      border-radius: 3px;
    }
    #searchBtn {
      padding: 5px 10px;
      margin-left: 5px;
      border: none;
      border-radius: 3px;
      background-color: #00adee;
      color: #fff;
      cursor: pointer;
    }
    /* Chart container fills the rest of the space and is scrollable */
    #chart {
      flex: 1;
      overflow: auto;
      background-color: #1e1e1e;
    }
    .node {
      cursor: pointer;
    }
    .node circle {
      fill: #4c4c4c;
      stroke: #00adee;
      stroke-width: 1.5px;
    }
    .node text {
      font: 12px sans-serif;
      fill: #eee;
    }
    /* Highlight class for matched nodes */
    .highlight {
      stroke: #ff0000 !important;
      stroke-width: 3px;
    }
    .link {
      fill: none;
      stroke: #888;
      stroke-width: 1.5px;
    }
    /* Context menu styling */
    .context-menu {
      position: absolute;
      background: #333;
      color: white;
      border-radius: 5px;
      display: none;
      box-shadow: 2px 2px 5px rgba(0, 0, 0, 0.5);
      font-size: 14px;
      z-index: 1000;
      min-width: 120px;
    }
    .context-menu-item {
      padding: 8px;
      cursor: pointer;
      border-bottom: 1px solid #444;
    }
    .context-menu-item:hover {
      background: #555;
    }
    .context-menu-item:last-child {
      border-bottom: none;
    }
  </style>
</head>
<body>
  <div id="context-menu" class="context-menu">
    <div class="context-menu-item" id="toggle-node">Toggle</div>
    <div class="context-menu-item" id="open-blk">Open BLK</div>
  </div>
  <div id="container">
    <div id="search-container">
      <input id="searchInput" type="text" placeholder="Search nodes..." />
      <button id="searchBtn">Search</button>
    </div>
    <div id="chart"></div>
  </div>
  <!-- Load D3.js -->
  <script src="https://d3js.org/d3.v5.min.js"></script>
  <script>
    const vscode = acquireVsCodeApi();

    // Set up margin and dynamic dimensions.
    const margin = { top: 20, right: 90, bottom: 30, left: 90 };
    const container = document.getElementById("chart");
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const width = containerWidth - margin.left - margin.right;
    const height = containerHeight - margin.top - margin.bottom;

    // Create an SVG element that fills the container.
    const svg = d3.select("#chart").append("svg")
      .attr("width", containerWidth)
      .attr("height", containerHeight)
      .call(d3.zoom().scaleExtent([0.1, 3]).on("zoom", zoomed));

    // Group that will be zoomed and panned.
    const g = svg.append("g")
      .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    function zoomed() {
      g.attr("transform", d3.event.transform);
    }

    let i = 0,
        duration = 750,
        root;
    const levelSeparation = 250; // Increased separation between levels.
    const treemap = d3.cluster().size([height, width]);

    document.addEventListener("click", () => {
      document.getElementById("context-menu").style.display = "none";
    });

    function showContextMenu(d) {
      selectedNode = d;        // Store selected node for actions

      const menu = document.getElementById("context-menu");
      menu.style.display = "block";
      menu.style.left = event.pageX + "px";
      menu.style.top = event.pageY + "px";
    }

    function toggleNode() {
      console.log({selectedNode});
      if (selectedNode) {
        if (selectedNode.children) {
          selectedNode._children = selectedNode.children;
          selectedNode.children = null;
        } else {
          selectedNode.children = selectedNode._children;
          selectedNode._children = null;
        }
        update(root);
      }
    }

    function openBLK() {
      if (selectedNode) {
        vscode.postMessage({ command: "openBLK", data: selectedNode.data });
      }
    }

    document.getElementById("toggle-node").addEventListener("click", toggleNode);
    document.getElementById("open-blk").addEventListener("click", openBLK);

    function update(source) {
      const treeData = treemap(root),
            nodes = treeData.descendants(),
            links = treeData.descendants().slice(1);

      // Set horizontal spacing based on depth.
      nodes.forEach(d => { d.y = d.depth * levelSeparation; });

      // --- Nodes ---
      const node = g.selectAll("g.node")
        .data(nodes, d => d.id || (d.id = ++i));

      const nodeEnter = node.enter().append("g")
        .attr("class", "node")
        .attr("transform", d => "translate(" + source.y0 + "," + source.x0 + ")")
        .on("click", function(d) {
          // Toggle children on click.
          if (d.children) {
            d._children = d.children;
            d.children = null;
          } else {
            d.children = d._children;
            d._children = null;
          }
          // Update the entire tree (using the root) to refresh positions.
          update(root);
          // Send a message to the extension with the clicked node's data.
          vscode.postMessage({ command: "nodeClicked", data: d.data });
          // TODO: Add your custom code here.
        })
        .on("contextmenu", function(d) {
          d3.event.preventDefault(); // Prevent default right-click menu
          showContextMenu(d); // Pass the correct event
        });

      nodeEnter.append("circle")
        .attr("class", "node")
        .attr("r", 1e-6)
        .style("fill", d => d._children ? "#00adee" : "#4c4c4c");

      nodeEnter.append("text")
        .attr("dy", ".35em")
        .attr("x", d => d.children || d._children ? -13 : 13)
        .attr("text-anchor", d => d.children || d._children ? "end" : "start")
        .text(d => d.data.name);

      const nodeUpdate = nodeEnter.merge(node);

      nodeUpdate.transition()
        .duration(duration)
        .attr("transform", d => "translate(" + d.y + "," + d.x + ")");

      nodeUpdate.select("circle.node")
        .attr("r", 10)
        .style("fill", d => d._children ? "#00adee" : "#4c4c4c")
        .attr("cursor", "pointer");

      const nodeExit = node.exit().transition()
          .duration(duration)
          .attr("transform", d => "translate(" + source.y + "," + source.x + ")")
          .remove();

      nodeExit.select("circle")
        .attr("r", 1e-6);

      nodeExit.select("text")
        .style("fill-opacity", 1e-6);

      // --- Links ---
      const link = g.selectAll("path.link")
        .data(links, d => d.id);

      const linkEnter = link.enter().insert("path", "g")
        .attr("class", "link")
        .attr("d", d => {
          const o = { x: source.x0, y: source.y0 };
          return diagonal(o, o);
        });

      const linkUpdate = linkEnter.merge(link);

      linkUpdate.transition()
        .duration(duration)
        .attr("d", d => diagonal(d, d.parent));

      const linkExit = link.exit().transition()
          .duration(duration)
          .attr("d", d => {
            const o = { x: source.x, y: source.y };
            return diagonal(o, o);
          })
          .remove();

      nodes.forEach(d => {
        d.x0 = d.x;
        d.y0 = d.y;
      });

      function diagonal(s, d) {
        return \`M \${s.y} \${s.x}
          C \${(s.y + d.y) / 2} \${s.x},
            \${(s.y + d.y) / 2} \${d.x},
            \${d.y} \${d.x}\`;
      }
    }

    function updateTree(data) {
      root = d3.hierarchy(data, d => d.children);
      root.x0 = height / 2;
      root.y0 = 0;
      update(root);
    }

    // --- Search functionality ---
    function searchNodes() {
      const searchText = document.getElementById("searchInput").value.toLowerCase();
      // Loop through each node and add/remove highlight class.
      g.selectAll("g.node").each(function(d) {
        const circle = d3.select(this).select("circle");
        if (d.data.name.toLowerCase().includes(searchText) && searchText !== "") {
          circle.classed("highlight", true);
        } else {
          circle.classed("highlight", false);
        }
      });
    }

    // Attach event listeners to the search box and button.
    document.getElementById("searchInput").addEventListener("keyup", searchNodes);
    document.getElementById("searchBtn").addEventListener("click", searchNodes);

    // Listen for messages from the extension.
    window.addEventListener("message", event => {
      const message = event.data;
      if (message.command === "setData") {
        console.log({data: message.data});
        updateTree(message.data);
      }
    });
  </script>
</body>
</html>`;
}