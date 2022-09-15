const core = require('@actions/core')
const github = require('@actions/github')
const lspClient = require('ts-lsp-client')
const child_process = require('child_process')
const process = require('node:process')
const path = require('node:path')
const fs = require('fs/promises')

function createAnnotations(linterOutputs) {

  annotations = []
  core.debug(linterOutputs)
  for (const linterOutput of linterOutputs) {
    core.debug(`Iterating errors returned for: ${linterOutput.uri}`)

    for (const diagnostic of linterOutput.diagnostics) {
      core.debug(`${linterOutput.uri}: diagnostic: ${diagnostic}`)

      annotations.push({
        path: linterOutput.uri,
        start_line: diagnostic.range.start.line,
        end_line: diagnostic.range.end.line,
        message: diagnostic.message,
        start_column: diagnostic.range.start.character,
        annotation_level: 'failure',
        end_column: diagnostic.range.end.character,
      })
    }
  }

  return annotations;
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

  core.debug(`Start linting: ${filenames}`)

  const token = core.getInput('repo-token')
  const octokit = new github.getOctokit(token)
  const check = await octokit.rest.checks.create({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    name: 'jsonlinter-action',
    head_sha: github.context.sha,
    status: 'in_progress',
  })

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

  const annotations = createAnnotations(results)

  core.debug('Creating annotations.')

  if (annotations.length) {
    await octokit.rest.checks.update({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      check_run_id: check.data.id,
      name: check.data.name,
      head_sha: github.context.sha,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: `${check.data.name}: output`,
        summary: `${annotations.length} annotations written.`,
        annotations: annotations,
      },
    })

    core.setFailed(
      `${annotations.length} errors encountered while linting JSON files.`
    )
  } else {
    await octokit.rest.checks.update({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      check_run_id: check.data.id,
      name: check.data.name,
      head_sha: github.context.sha,
      status: 'completed',
      conclusion: 'success',
      output: {
        title: `${check.data.name}: output`,
        summary: `${annotations.length} annotations written.`,
        annotations: annotations,
      },
    })
  }

  core.debug('Shutting down languageserver.')
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
