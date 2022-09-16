const core = require('@actions/core')
const github = require('@actions/github')
const lspClient = require('ts-lsp-client')
const child_process = require('child_process')
const process = require('node:process')
const path = require('node:path')
const fs = require('fs/promises')

function createAnnotations(linterOutputs) {
  let annotations = []
  core.debug(linterOutputs)
  for (const linterOutput of linterOutputs) {
    core.debug(`Iterating errors returned for: ${linterOutput.uri}`)

    for (const diagnostic of linterOutput.diagnostics) {
      core.debug(
        `${linterOutput.uri}: diagnostic: ${JSON.stringify(diagnostic)}`
      )

      const annotation = {
        path: linterOutput.uri,
        start_line: diagnostic.range.start.line,
        end_line: diagnostic.range.end.line,
        title: diagnostic.message,
        message: diagnostic.message,
        start_column: diagnostic.range.start.character,
        end_column: diagnostic.range.end.character,
        annotation_level: 'failure',
      }

      core.debug(
        `${linterOutput.uri}: annotation: ${JSON.stringify(annotation)}`
      )
      annotations.push(annotation)
    }
  }

  return annotations
}

async function initializeLSPClient() {
  core.debug('Initializing vscode-json-languageserver')

  const lspProcess = child_process.spawn('node', [
    path.join(
      __dirname,
      'node_modules',
      'vscode-json-languageserver',
      'bin',
      'vscode-json-languageserver'
    ),
    '--stdio',
  ])

  const endpoint = new lspClient.JSONRPCEndpoint(
    lspProcess.stdin,
    lspProcess.stdout
  )
  const client = new lspClient.LspClient(endpoint)

  core.debug('Initializing languageserver client')

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

  core.debug('Languageserver client initialized.')
  return client
}

async function lintFiles(filenames) {
  const client = await initializeLSPClient()

  const token = core.getInput('repo-token')
  const octokit = github.getOctokit(token)
  const started_at = new Date().toISOString()

  const check = await octokit.rest.checks.create({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    name: 'jsonlinter-action',
    head_sha: github.context.sha,
    status: 'in_progress',
  })

  core.debug(`Start linting: ${filenames}`)

  let results = []
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

    core.debug(
      `Waiting languageserver client to respond with diagnostics for ${filename}.`
    )
    const result = await client.once('textDocument/publishDiagnostics')

    core.debug(`Languageserver client responded for ${filename}.`)
    results = results.concat(result)

    client.didClose({
      uri: filename,
    })
  }

  core.debug('Shutting down languageserver.')
  client.shutdown()
  client.exit()

  const annotations = createAnnotations(results)

  if (annotations.length) {
    core.debug('Creating annotations.')

    await octokit.rest.checks.update({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      check_run_id: check.data.id,
      name: check.data.name,
      head_sha: github.context.sha,
      status: 'completed',
      conclusion: 'failure',
      started_at: started_at,
      completed_at: new Date().toISOString(),
      output: {
        title: 'jsonlinter-action: output',
        summary: `${annotations.length} annotations written.`,
        annotations: annotations,
      },
    })

    core.setFailed(
      `${annotations.length} errors encountered while linting JSON files.`
    )
  }
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
