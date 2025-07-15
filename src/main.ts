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
  const match = url.match(/github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)/)
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

  // Fetch all items with pagination
  const allItems: ProjectItem[] = []
  let hasNextPage = true
  let cursor: string | null = null
  let pageCount = 0

  try {
    while (hasNextPage) {
      pageCount++
      core.info(`Fetching page ${pageCount} of project items...`)
      const query = `
        query($owner: String!, $projectNumber: Int!, $after: String) {
          ${isOrg ? 'organization' : 'user'}(login: $owner) {
            projectV2(number: $projectNumber) {
              items(first: 100, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                                  fieldValues(first: 20) {
                  nodes {
                    __typename
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
                    ... on ProjectV2ItemFieldUserValue {
                      field {
                        ... on ProjectV2FieldCommon {
                          name
                        }
                      }
                      users(first: 10) {
                        nodes {
                          login
                        }
                      }
                    }
                    ... on ProjectV2ItemFieldDateValue {
                      field {
                        ... on ProjectV2FieldCommon {
                          name
                        }
                      }
                      date
                    }
                  }
                }
                                  content {
                  __typename
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

      const response = (await graphqlWithAuth(query, {
        owner,
        projectNumber,
        after: cursor
      })) as any

      const project = response[isOrg ? 'organization' : 'user']?.projectV2
      if (!project) {
        throw new Error(`Project not found: ${owner}/${projectNumber}`)
      }

      // Process items from this page
      for (const item of project.items.nodes) {
        // Handle items with null/undefined content but try to extract from field values
        if (!item.content) {
          core.info(
            `⚠️ Item with null content: ID=${item.id} | FieldValues: ${item.fieldValues?.nodes?.length || 0}`
          )

          // Try to extract information from field values
          let title = 'Unknown Title'
          let status = 'Unknown'
          const assignees: string[] = []

          let createdAt = new Date().toISOString()
          let updatedAt = new Date().toISOString()

          if (item.fieldValues?.nodes) {
            for (const fieldValue of item.fieldValues.nodes) {
              const fieldName = fieldValue.field?.name
              core.info(
                `Field: ${fieldName} | Value type: ${fieldValue.__typename} | Keys: ${Object.keys(fieldValue).join(', ')}`
              )

              if (fieldName === 'Title') {
                title = fieldValue.text || fieldValue.name || title
              } else if (fieldName === 'Status') {
                status = fieldValue.name || fieldValue.text || status
              } else if (fieldName === 'Assignees') {
                core.info(
                  `Assignee field structure: ${JSON.stringify(fieldValue, null, 2)}`
                )
                // Extract assignees from the field value
                if (fieldValue.users?.nodes) {
                  assignees.push(
                    ...fieldValue.users.nodes.map((user: any) => user.login)
                  )
                } else if (fieldValue.text) {
                  // Handle text-based assignee field
                  assignees.push(fieldValue.text)
                }
              } else if (
                fieldName === 'Created' ||
                fieldName === 'Date created'
              ) {
                createdAt = fieldValue.date || fieldValue.text || createdAt
              } else if (
                fieldName === 'Updated' ||
                fieldName === 'Date updated' ||
                fieldName === 'Last updated'
              ) {
                updatedAt = fieldValue.date || fieldValue.text || updatedAt
              }
            }
          }

          core.info(
            `📝 Processing item from field values: "${title}" | Status: ${status}`
          )

          allItems.push({
            id: item.id,
            title,
            url: `https://github.com/orgs/${owner}/projects/${projectNumber}`,
            status,
            assignees,
            labels: [],
            createdAt,
            updatedAt,
            type: 'DraftIssue', // assume draft for items without content
            repository: undefined,
            number: undefined
          })
          continue
        }

        core.info(
          `📝 Processing item: ${item.content.title || 'No title'} (Type: ${item.content.__typename || 'Unknown'}) | Content keys: ${Object.keys(item.content).join(', ')}`
        )

        const content = item.content
        const assignees =
          content.assignees?.nodes?.map((a: any) => a.login) || []
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

        allItems.push({
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

      // Update pagination variables
      hasNextPage = project.items.pageInfo.hasNextPage
      cursor = project.items.pageInfo.endCursor

      const itemsWithContent = project.items.nodes.filter(
        (item: any) => item.content
      ).length
      const itemsWithoutContent = project.items.nodes.length - itemsWithContent
      core.info(
        `Page ${pageCount}: Found ${project.items.nodes.length} items (${itemsWithContent} with content, ${itemsWithoutContent} without). Total processed so far: ${allItems.length}. HasNextPage: ${hasNextPage}`
      )
    }

    core.info(
      `✅ Pagination complete! Fetched ${allItems.length} total items across ${pageCount} pages`
    )
    return allItems
  } catch (error) {
    core.error(`Error fetching project data: ${error}`)
    throw error
  }
}

/**
 * Get emoji for item status
 */
function getStatusEmoji(status: string): string {
  const statusLower = status.toLowerCase()
  if (
    statusLower.includes('todo') ||
    statusLower.includes('to do') ||
    statusLower.includes('backlog')
  ) {
    return '📋'
  }
  if (
    statusLower.includes('progress') ||
    statusLower.includes('doing') ||
    statusLower.includes('active')
  ) {
    return '🚧'
  }
  if (
    statusLower.includes('done') ||
    statusLower.includes('complete') ||
    statusLower.includes('finished')
  ) {
    return '✅'
  }
  return '📝' // Default for unknown status
}

/**
 * Get status priority for sorting (lower number = higher priority)
 */
function getStatusPriority(status: string): number {
  const statusLower = status.toLowerCase()
  if (
    statusLower.includes('todo') ||
    statusLower.includes('to do') ||
    statusLower.includes('backlog')
  ) {
    return 1 // Todo first
  }
  if (
    statusLower.includes('progress') ||
    statusLower.includes('doing') ||
    statusLower.includes('active')
  ) {
    return 2 // In Progress second
  }
  if (
    statusLower.includes('done') ||
    statusLower.includes('complete') ||
    statusLower.includes('finished')
  ) {
    return 3 // Done last
  }
  return 4 // Unknown status last
}

/**
 * Check if an item should be included in the output
 * - Always include Todo and In Progress items
 * - Only include Done items if completed within the last 24 hours
 */
function shouldIncludeItem(item: ProjectItem): boolean {
  const statusLower = item.status.toLowerCase()
  const isDone =
    statusLower.includes('done') ||
    statusLower.includes('complete') ||
    statusLower.includes('finished')

  // Debug logging to understand what's happening
  core.info(
    `Item: "${item.title}" | Status: "${item.status}" | isDone: ${isDone}`
  )

  if (!isDone) {
    return true // Always include non-Done items (Todo, In Progress, etc.)
  }

  // For Done items, only include if completed within 24 hours
  const now = new Date()
  const updatedAt = new Date(item.updatedAt)
  const hoursDiff = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60)

  const shouldInclude = hoursDiff <= 24
  core.info(
    `Done item: "${item.title}" | Hours since update: ${hoursDiff.toFixed(1)} | Including: ${shouldInclude}`
  )

  return shouldInclude
}

/**
 * Format date for display (UTC)
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  })
}

/**
 * Group items by assignees and filter/sort them
 */
function groupItemsByAssignees(items: ProjectItem[]): UserAssignments {
  const userAssignments: UserAssignments = {}

  // First, group all items by assignees (without filtering)
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

  // Debug: log users before filtering
  core.info(
    `Users before filtering: ${Object.keys(userAssignments).join(', ')}`
  )
  for (const user in userAssignments) {
    core.info(
      `${user}: ${userAssignments[user].length} items (${userAssignments[user].map((item) => item.status).join(', ')})`
    )
  }

  // Now filter items within each user's list - only show Done items if completed within 24h
  for (const user in userAssignments) {
    const beforeCount = userAssignments[user].length
    userAssignments[user] = userAssignments[user].filter(shouldIncludeItem)
    const afterCount = userAssignments[user].length

    core.info(
      `${user}: ${beforeCount} items → ${afterCount} items after filtering`
    )

    // Remove users who have no items left after filtering
    if (userAssignments[user].length === 0) {
      core.info(`Removing ${user} - no items left after filtering`)
      delete userAssignments[user]
    }
  }

  // Debug: log users after filtering
  core.info(`Users after filtering: ${Object.keys(userAssignments).join(', ')}`)

  // Sort items within each user by status priority
  for (const user in userAssignments) {
    userAssignments[user].sort((a, b) => {
      const priorityA = getStatusPriority(a.status)
      const priorityB = getStatusPriority(b.status)
      if (priorityA !== priorityB) {
        return priorityA - priorityB
      }
      // If same status priority, sort by updated date (newest first)
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
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
      const statusEmoji = getStatusEmoji(item.status)
      const statusBadge = item.status !== 'Unknown' ? `${item.status}` : ''
      const repoInfo = item.repository
        ? `[${item.repository}${item.number ? `#${item.number}` : ''}]`
        : ''

      // Add completion date for Done items
      const isDone =
        item.status.toLowerCase().includes('done') ||
        item.status.toLowerCase().includes('complete') ||
        item.status.toLowerCase().includes('finished')
      const completionInfo = isDone ? ` (${formatDate(item.updatedAt)})` : ''

      userSection.push(
        `  ${statusEmoji} ${statusBadge} <${item.url}|${item.title}>${completionInfo} ${repoInfo}`
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
      username: 'Agglayer Github Project Notifier',
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
