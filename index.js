const core = require('@actions/core')
const github = require('@actions/github')
const lspClient = require('ts-lsp-client')
const child_process = require('child_process')
const process = require('node:process')
const fs = require('fs/promises')
const path = require('path');

async function createAnnotation(linterOutput) {
  const token = core.getInput('repo-token')
  const octokit = new github.getOctokit(token)

  if (linterOutput.diagnostics.length === 0) {
    core.notice(`${filename} found no errors!`)
    return
  }

  for (diagnostic of linterOutput.diagnostics) {
    await octokit.rest.checks.create({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      name: 'jsonlinter-action',
      head_sha: github.context.sha,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: diagnostic.message,
        summary: diagnostic.message,
        annotations: [
          {
            path: linterOutput.uri,
            start_line: diagnostic.range.start.line,
            end_line: diagnostic.range.end.line,
            message: diagnostic.message,
            start_column: diagnostic.range.start.character,
            end_column: diagnostic.range.end.character,
          },
        ],
      },
    })
  }
}

async function initializeLSPClient() {
  const lspProcess = child_process.spawn('node', [
    'node_modules/vscode-json-languageserver/bin/vscode-json-languageserver',
    '--stdio',
  ])

  const endpoint = new lspClient.JSONRPCEndpoint(
    lspProcess.stdin,
    lspProcess.stdout
  )
  const client = new lspClient.LspClient(endpoint)

  await client.initialize({
    processId: process.pid,
    capabilities: {},
    client: 'jsonlinter-action',
    workspaceFolders: [
      {
        name: 'workspace',
        uri: process.cwd(),
      },
    ],
  })

  return client
}

async function lintFiles(filenames) {
  const client = await initializeLSPClient()

  for (const filename of filenames) {
    core.notice(`Linting ${filename}...`)
	project_path = process.env('GITHUB_WORKSPACE')
	full_path = path.join(project_path, filename)
    const contents = await fs.readFile(full_path, 'utf8')

    client.didOpen({
      textDocument: {
        uri: filename,
        languageId: 'json',
        version: 1,
        text: contents,
      },
    })

    const result = await client.once('textDocument/publishDiagnostics')
    await createAnnotation(result[0])

    client.didClose({
      uri: filename,
    })
  }

  client.shutdown()
  client.exit()
}

;(async () => {
  try {
    core.notice('Running jsonlinter-action')
    core.notice(`Files found: ${core.getInput('files')}`)
    const files = core
      .getInput('files')
      .split(',')
      .map((f) => f.trim())
    lintFiles(files)
  } catch (error) {
    core.setFailed(error.message)
  }
})()
