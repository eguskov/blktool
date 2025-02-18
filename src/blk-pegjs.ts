'use strict';

import * as vscode from 'vscode';

import { readFile } from 'fs';

import * as pegjs from 'pegjs';

async function getParser(): Promise<any> {
	return new Promise<any>((resolve, reject) => {
		readFile(`${__dirname}/../../blk.pegjs`, (err, content) => {
			if (!!err) {
				reject(err);
			}
			else {
				resolve(pegjs.generate(content.toString()));
			}
		});
	});
}

export namespace blk
{
  let g_diagnostic_collection: vscode.DiagnosticCollection = null;

  export function setDiagnosticCollection(diagnosticCollection: vscode.DiagnosticCollection)
  {
    g_diagnostic_collection = diagnosticCollection;
  }

  export class RangeFormattingEditProvider implements vscode.DocumentRangeFormattingEditProvider
  {
    onlyValidate = false;
    edits: vscode.TextEdit[] = [];

    addEdit(document: vscode.TextDocument, from: number, to: number, replaceWith: string)
    {
      if (this.onlyValidate)
        return;

      let range = new vscode.Range(document.positionAt(from), document.positionAt(to));
      if (document.validateRange(range))
        this.edits.push(vscode.TextEdit.replace(range, replaceWith));
    }

    addInsert(document: vscode.TextDocument, at: number, text: string)
    {
      if (!this.onlyValidate)
        this.edits.push(vscode.TextEdit.insert(document.positionAt(at), text));
    }

    async provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): Promise<vscode.TextEdit[]>
    {
      this.edits = [];

      let errors: vscode.Diagnostic[] = [];

      g_diagnostic_collection.clear();

      let fullText = document.getText(/* range */);
      
      let parser = await getParser();

      const tabSize = 2
      const indentWith = ' '

      try {
        let blkRoot = parser.parse(fullText);

        let formatBlock = function (block, level) {
          let blockLine = block.location.start.line;
          let paramLinePrev = -1;
          for (let i = 0; i < block.params.length; ++i) {
            let param = block.params[i]
            let paramNext = block.params[i + 1]
            let paramLine = param.location.start.line
            let paramLineNext = paramNext ? paramNext.location.start.line : -1
            if ((paramLineNext === paramLine && paramLineNext !== -1) || paramLine === paramLinePrev || paramLine === blockLine) {
              let ch = document.getText(new vscode.Range(document.positionAt(param.location.end.offset - 1), document.positionAt(param.location.end.offset)))
              if (ch !== ';')
                this.addInsert(document, param.location.end.offset, ';')
              if (paramLinePrev === -1 && paramLine !== blockLine) {
                const indent = indentWith.repeat(level * tabSize);
                this.addEdit(document, param.indent.start.offset, param.indent.end.offset, indent);
              }
              else
                this.addEdit(document, param.indent.start.offset, param.indent.end.offset, ' ');
            }
            else {
              const indent = indentWith.repeat(level * tabSize);
              this.addEdit(document, param.indent.start.offset, param.indent.end.offset, indent);
            }
            paramLinePrev = param.location.start.line;
          }
          for (let subBlock of block.blocks) {
            formatBlock(subBlock, level + 1);
          }
        }.bind(this);

        function formatParamName(param): string {          
          if (param.value[0][0] === "@")
            return `"${param.value[0]}"`;
          return param.value[0];
        }

        function formatParamValue(param): string {
          let paramValue = param.value[2];
          if (param.value[1] === "t" && paramValue[0] !== "'" && paramValue[0] !== '"')
            return `"${paramValue}"`;
          return paramValue;
        }

        function formatBlockName(block): string {          
          if (block.name[0] === "@")
            return `"${block.name}"`;
          return block.name;
        }

        function removeTrailingWhitespace(str: string) {
          return str.split('\n').map(v => v.replace(/\s+$/, '')).join('\n');
        }

        let replaceBlock = function (block, level) {
          let lines = [];
          for (let param of block.params) {
            if (!lines[param.location.start.line])
              lines[param.location.start.line] = [];
            lines[param.location.start.line].push({ type: 'param', value: param });
          }
          for (let subBlock of block.blocks) {
            if (!lines[subBlock.location.start.line])
              lines[subBlock.location.start.line] = [];
            lines[subBlock.location.start.line].push({ type: 'block', value: subBlock });
          }
          for (let include of block.includes) {
            if (!lines[include.location.start.line])
              lines[include.location.start.line] = [];
            lines[include.location.start.line].push({ type: 'include', value: include });
          }
          for (let comment of block.comments) {
            if (!lines[comment.location.start.line])
              lines[comment.location.start.line] = [];
            lines[comment.location.start.line].push({ type: 'comment', value: comment });
          }
          let emptylines = block.emptylines.filter(v => v.location.start.column === 1);

          let emptylinesCount = 0;
          for (let i = 1; i < emptylines.length; ++i) {
            if (emptylines[i].location.start.line - 1 === emptylines[i - 1].location.start.line) {
              ++emptylinesCount;
            }
            else {
              for (let j = i - 1; j >= 0 && j > i - emptylinesCount; --j) {
                emptylines[j]._remove = true;
              }
              emptylinesCount = 0;
            }
          }
          for (let j = emptylines.length - 1; j >= 0 && j > emptylines.length - emptylinesCount; --j) {
            emptylines[j]._remove = true;
          }
          for (let emptyline of emptylines.filter(v => v._remove !== true)) {
            const lineNum = emptyline.location.start.line
            if (!lines[lineNum])
              lines[lineNum] = [];
            lines[lineNum].push({ type: 'empty line', value: emptyline });
          }
          
          const indent = indentWith.repeat(level * tabSize);
          const isRoot = block.name === '';
          const isEmpty = block.params.length <= 0 && block.blocks.length <= 0 && block.includes.length <= 0 && block.comments.length <= 0;
          const isOneLine = !isRoot && block.blocks.length <= 0 && block.includes.length <= 0  && block.comments.length <= 0 && block.params.length > 0 && block.location.start.line === block.params[0].location.start.line;
          const isMultiLine = !isOneLine && !isEmpty;
          const prevIndent = isOneLine || isEmpty || isRoot ? '' : (indentWith.repeat((level - 1) * tabSize));

          const fmt = {
            param: v => `${isOneLine ? '' : indent}${formatParamName(v)}:${v.value[1]} = ${formatParamValue(v)}`,
            block: v => `${indent}${replaceBlock(v, level + 1)}`,
            include: v => `${indent}include "${v.value}"`,
            comment: (v, f) => `${f ? ' ' : indent}${removeTrailingWhitespace(v.value)}`,
            'empty line': () => null
          }
          
          let content = [];

          if (isMultiLine && !isRoot) {
            content.push("\n");
          }

          lines = lines.filter(v => !!v)

          if (isOneLine) {
            lines = [lines.reduce((res, v) => res.concat(v), [])];
          }

          for (let line of lines) {
            const isEndWithComment = line.length > 1 && line[line.length - 1].type === 'comment';
            if (isOneLine) {
              content.push(" ");
            }
            const str = line.map(v => fmt[v.type](v.value, isEndWithComment)).filter(v => !!v).join(isMultiLine && !isEndWithComment ? "\n" : isOneLine ? "; " : "");
            content.push(str);
            if (isMultiLine) {
              content.push("\n");
            }
            else if (isOneLine) {
              content.push("; ");
            }
          }

          if (isRoot)
            return content.join("");

          return `${formatBlockName(block)} {${content.join("")}${prevIndent}}`;
        }.bind(this);

        let level = 0;
        const blockFormatted = replaceBlock(blkRoot, level);
        this.addEdit(document, blkRoot.location.start.offset, blkRoot.location.end.offset, blockFormatted);
      }
      catch (err) {
        console.log(err.message);
        let errRange = new vscode.Range(document.positionAt(err.location.start.offset), document.positionAt(err.location.end.offset));
        errors.push(new vscode.Diagnostic(errRange, `Line: ${err.location.start.line}; Message: ${err.message}`, vscode.DiagnosticSeverity.Error));
      }


      if (!this.onlyValidate && errors.length > 0 && this.edits.length > 0)
      {
        this.onlyValidate = true;
        setTimeout(() => this.provideDocumentRangeFormattingEdits(document, range, options, token), 500);
      }
      else if (this.onlyValidate)
      {
        this.onlyValidate = false;
        g_diagnostic_collection.set(document.uri, errors);
      }

      if (errors.length > 0)
        g_diagnostic_collection.set(document.uri, errors);

      return Promise.resolve(this.edits);
    }
  }
}