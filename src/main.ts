import * as core from '@actions/core'
import { graphql } from '@octokit/graphql'
import { WebClient } from '@slack/web-api'

interface ProjectItem {
  id: string
  title: string
  url: string
  status: string
  assignees: string[]
  labels: string[]
  createdAt: string
  updatedAt: string
  type: 'Issue' | 'DraftIssue' | 'PullRequest'
  repository?: string
  number?: number
}

interface UserAssignments {
  [username: string]: ProjectItem[]
}

/**
 * Parse GitHub Project URL to extract owner, project number, and type
 */
function parseProjectUrl(url: string): {
  owner: string
  projectNumber: number
  isOrg: boolean
} {
  const match = url.match(
    /github\.com\/(orgs|users)\/([^\/]+)\/projects\/(\d+)/
  )
  if (!match) {
    throw new Error(`Invalid project URL format: ${url}`)
  }

  const [, type, owner, projectNumber] = match
  return {
    owner,
    projectNumber: parseInt(projectNumber, 10),
    isOrg: type === 'orgs'
  }
}

/**
 * Fetch project data from GitHub GraphQL API
 */
async function fetchProjectData(
  token: string,
  owner: string,
  projectNumber: number,
  isOrg: boolean
): Promise<ProjectItem[]> {
  const graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${token}`
    }
  })

  const query = `
    query($owner: String!, $projectNumber: Int!) {
      ${isOrg ? 'organization' : 'user'}(login: $owner) {
        projectV2(number: $projectNumber) {
          items(first: 100) {
            nodes {
              id
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                    text
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    field {
                      ... on ProjectV2FieldCommon {
                        name
                      }
                    }
                    name
                  }
                }
              }
              content {
                ... on Issue {
                  title
                  url
                  number
                  createdAt
                  updatedAt
                  assignees(first: 10) {
                    nodes {
                      login
                    }
                  }
                  labels(first: 10) {
                    nodes {
                      name
                    }
                  }
                  repository {
                    name
                  }
                }
                ... on PullRequest {
                  title
                  url
                  number
                  createdAt
                  updatedAt
                  assignees(first: 10) {
                    nodes {
                      login
                    }
                  }
                  labels(first: 10) {
                    nodes {
                      name
                    }
                  }
                  repository {
                    name
                  }
                }
                ... on DraftIssue {
                  title
                  createdAt
                  updatedAt
                  assignees(first: 10) {
                    nodes {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `

  try {
    const response = (await graphqlWithAuth(query, {
      owner,
      projectNumber
    })) as any

    const project = response[isOrg ? 'organization' : 'user']?.projectV2
    if (!project) {
      throw new Error(`Project not found: ${owner}/${projectNumber}`)
    }

    const items: ProjectItem[] = []

    for (const item of project.items.nodes) {
      if (!item.content) continue

      const content = item.content
      const assignees = content.assignees?.nodes?.map((a: any) => a.login) || []
      const labels = content.labels?.nodes?.map((l: any) => l.name) || []

      // Get status from field values
      let status = 'Unknown'
      for (const fieldValue of item.fieldValues.nodes) {
        if (fieldValue.field?.name === 'Status') {
          status = fieldValue.name || fieldValue.text || 'Unknown'
          break
        }
      }

      let type: 'Issue' | 'DraftIssue' | 'PullRequest'
      if (content.__typename === 'Issue') {
        type = 'Issue'
      } else if (content.__typename === 'PullRequest') {
        type = 'PullRequest'
      } else {
        type = 'DraftIssue'
      }

      items.push({
        id: item.id,
        title: content.title,
        url:
          content.url ||
          `https://github.com/${owner}/projects/${projectNumber}`,
        status,
        assignees,
        labels,
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
        type,
        repository: content.repository?.name,
        number: content.number
      })
    }

    return items
  } catch (error) {
    core.error(`Error fetching project data: ${error}`)
    throw error
  }
}

/**
 * Group items by assignees
 */
function groupItemsByAssignees(items: ProjectItem[]): UserAssignments {
  const userAssignments: UserAssignments = {}

  for (const item of items) {
    if (item.assignees.length === 0) {
      // Add to "Unassigned" if no assignees
      if (!userAssignments['Unassigned']) {
        userAssignments['Unassigned'] = []
      }
      userAssignments['Unassigned'].push(item)
    } else {
      // Add to each assignee
      for (const assignee of item.assignees) {
        if (!userAssignments[assignee]) {
          userAssignments[assignee] = []
        }
        userAssignments[assignee].push(item)
      }
    }
  }

  return userAssignments
}

/**
 * Format items for Slack message
 */
function formatSlackMessage(
  userAssignments: UserAssignments,
  maxItemsPerUser: number
): string {
  const sections: string[] = []

  // Sort users alphabetically, but put "Unassigned" at the end
  const sortedUsers = Object.keys(userAssignments).sort((a, b) => {
    if (a === 'Unassigned') return 1
    if (b === 'Unassigned') return -1
    return a.localeCompare(b)
  })

  for (const user of sortedUsers) {
    const items = userAssignments[user]
    const displayItems = items.slice(0, maxItemsPerUser)
    const hasMore = items.length > maxItemsPerUser

    const userSection = [`*${user}* (${items.length} items):`]

    for (const item of displayItems) {
      const typeIcon =
        item.type === 'Issue' ? '🐛' : item.type === 'PullRequest' ? '🔄' : '📝'
      const statusBadge = item.status !== 'Unknown' ? `\`${item.status}\`` : ''
      const repoInfo = item.repository
        ? `[${item.repository}${item.number ? `#${item.number}` : ''}]`
        : ''

      userSection.push(
        `  ${typeIcon} ${statusBadge} <${item.url}|${item.title}> ${repoInfo}`
      )
    }

    if (hasMore) {
      userSection.push(
        `  _... and ${items.length - maxItemsPerUser} more items_`
      )
    }

    sections.push(userSection.join('\n'))
  }

  const totalItems = Object.values(userAssignments).reduce(
    (sum, items) => sum + items.length,
    0
  )
  const userCount = Object.keys(userAssignments).length

  const header = `📋 *Project Summary*\n${totalItems} items across ${userCount} assignees\n`

  return header + '\n' + sections.join('\n\n')
}

/**
 * Send message to Slack
 */
async function sendSlackMessage(
  botToken: string,
  channel: string,
  message: string
): Promise<void> {
  const slack = new WebClient(botToken)

  try {
    await slack.chat.postMessage({
      channel,
      text: message,
      username: 'GitHub Projects Bot',
      icon_emoji: ':github:'
    })
  } catch (error) {
    core.error(`Error sending Slack message: ${error}`)
    throw error
  }
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Get inputs
    const githubToken = core.getInput('github-token')
    const projectUrl = core.getInput('project-url')
    const slackBotToken = core.getInput('slack-bot-token')
    const slackChannel = core.getInput('slack-channel')
    const maxItemsPerUser = parseInt(core.getInput('max-items-per-user'), 10)

    // Validate inputs
    if (!githubToken || !projectUrl || !slackBotToken || !slackChannel) {
      throw new Error(
        'Missing required inputs: github-token, project-url, slack-bot-token, and slack-channel are required'
      )
    }

    core.info('🚀 Starting GitHub Projects to Slack summary...')

    // Parse project URL
    const { owner, projectNumber, isOrg } = parseProjectUrl(projectUrl)
    core.info(
      `📊 Fetching project data for ${owner}/${projectNumber} (${isOrg ? 'organization' : 'user'})`
    )

    // Fetch project data
    const items = await fetchProjectData(
      githubToken,
      owner,
      projectNumber,
      isOrg
    )
    core.info(`📥 Retrieved ${items.length} items from project`)

    // Group items by assignees
    const userAssignments = groupItemsByAssignees(items)
    const userCount = Object.keys(userAssignments).length
    core.info(`👥 Found ${userCount} assignees`)

    // Format message
    const message = formatSlackMessage(userAssignments, maxItemsPerUser)

    // Send to Slack
    core.info('📤 Sending message to Slack...')
    await sendSlackMessage(slackBotToken, slackChannel, message)

    // Set outputs
    core.setOutput('summary-sent', 'true')
    core.setOutput('total-items', items.length.toString())
    core.setOutput('users-count', userCount.toString())

    core.info('✅ Summary sent successfully!')
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}
