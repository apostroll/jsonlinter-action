const core = require('@actions/core')
const github = require('@actions/github')
const lspClient = require('ts-lsp-client')
const child_process = require('child_process')
const process = require('node:process')
const fs = require('fs/promises')

async function createAnnotation(linterOutput) {
  const token = core.getInput('repo-token')
  const octokit = new github.getOctokit(token)

  if (linterOutput.diagnostics.length === 0) {
    core.debug(`${linterOutput.uri} found no errors!`)
    return
  }

  core.debug(
    `${linterOutput.uri} has: ${linterOutput.diagnostics.length} errors!`
  )
  for (diagnostic of linterOutput.diagnostics) {
    core.debug(
      `${linterOutput.uri}: ${diagnostic.message} line: ${diagnostic.range.start.line}`
    )
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
            annotation_level: 'notice',
            end_column: diagnostic.range.end.character,
          },
        ],
      },
    })
  }
}

async function initializeLSPClient() {
  core.debug('Initializing vscode-json-languageserver')
  const lspProcess = child_process.spawn('node', [
    `${__dirname}/node_modules/vscode-json-languageserver/bin/vscode-json-languageserver`,
    '--stdio',
  ])

  const endpoint = new lspClient.JSONRPCEndpoint(
    lspProcess.stdin,
    lspProcess.stdout
  )
  const client = new lspClient.LspClient(endpoint)

  core.debug('Initializing languageserver client')
  const iDontReallyCare = await client.initialize({
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

  core.debug(JSON.stringify(iDontReallyCare))

  core.debug('Languageserver client initialized.')
  return client
}

async function lintFiles(filenames) {
  const client = await initializeLSPClient()

  core.debug(`Iterating ${filenames}`)
  for (const filename of filenames) {
    core.debug(`Linting ${filename}...`)
    const contents = await fs.readFile(filename, 'utf8')

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
    const files = core
      .getInput('files')
      .split(',')
      .map((f) => f.trim())
    await lintFiles(files)
  } catch (error) {
    core.setFailed(error.message)
  }
})()
