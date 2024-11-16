import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import fs from 'node:fs'
import { FullUser, Status, User } from 'twitter-d'
import { Item } from './model/collect-result'
import { Logger } from '@book000/node-utils'
import { SearchType, Twitter } from '@book000/twitterts'

type SearchesModel = Record<string, string>

function sanitizeFileName(fileName: string) {
  // Replace invalid characters for filenames
  return fileName.replaceAll(/[ "*/:<>?\\|]/g, '').trim()
}

function isFullUser(user: User): user is FullUser {
  return 'screen_name' in user
}

function getContent(tweet: Status) {
  let tweetText = tweet.full_text
  if (!tweetText) {
    throw new Error('tweet.full_text is empty')
  }
  const mediaUrls = []
  if (tweet.extended_entities?.media) {
    for (const media of tweet.extended_entities.media) {
      tweetText = tweetText.replace(media.url, '')
      mediaUrls.push(media.media_url_https)
    }
  }
  return [
    tweetText.trim(),
    mediaUrls.length > 0 ? '<hr>' : '',
    mediaUrls.map((url) => `<img src="${url}"><br>`).join('\n'),
  ].join('\n')
}

async function generateRSS() {
  const logger = Logger.configure('generateRSS')
  logger.info('🚀 Generating RSS...')

  if (!process.env.TWITTER_USERNAME || !process.env.TWITTER_PASSWORD) {
    throw new Error('TWITTER_USERNAME, TWITTER_PASSWORD is not set')
  }

  const proxyServer = process.env.PROXY_SERVER
  const proxyUsername = process.env.PROXY_USERNAME
  const proxyPassword = process.env.PROXY_PASSWORD
  const proxyConfiguration = proxyServer
    ? {
        server: proxyServer,
        username: proxyUsername,
        password: proxyPassword,
      }
    : undefined

  const twitter = await Twitter.login({
    username: process.env.TWITTER_USERNAME,
    password: process.env.TWITTER_PASSWORD,
    otpSecret: process.env.TWITTER_AUTH_CODE_SECRET,
    emailAddress: process.env.TWITTER_EMAIL_ADDRESS,
    puppeteerOptions: {
      executablePath: process.env.CHROMIUM_PATH,
      userDataDirectory: process.env.USER_DATA_DIRECTORY ?? './data/userdata',
      proxy: proxyConfiguration,
    },
    debugOptions: {
      outputResponse: {
        enable: process.env.DEBUG_OUTPUT_RESPONSE === 'true',
        onResponse: (response) => {
          logger.info(`📦 Response: ${response.type} ${response.name}`)
        },
      },
    },
  })

  try {
    const searchWordPath = process.env.SEARCH_WORD_PATH ?? 'data/searches.json'
    const searchWords: SearchesModel = JSON.parse(
      fs.readFileSync(searchWordPath, 'utf8'),
    )
    for (const key in searchWords) {
      const searchWord = searchWords[key]
      const startAt = new Date()
      logger.info(`🔎 Searching: ${searchWord}`)
      const builder = new XMLBuilder({
        ignoreAttributes: false,
        format: true,
        suppressEmptyNode: true,
      })

      const statuses = await twitter.searchTweets({
        query: searchWord,
        searchType: SearchType.LIVE,
      })
      const items: Item[] = statuses
        .filter((status) => isFullUser(status.user))
        .map((status) => {
          if (!isFullUser(status.user)) {
            throw new Error('status.user is not FullUser')
          }

          const content = getContent(status)

          return {
            id:
              'https://twitter.com/' +
              status.user.screen_name +
              '/status/' +
              status.id_str,
            title: status.full_text,
            updated: new Date(status.created_at).toISOString(),
            content,
            link: {
              '@_href':
                'https://twitter.com/' +
                status.user.screen_name +
                '/status/' +
                status.id_str,
            },
            published: new Date(status.created_at).toISOString(),
            author: {
              name: status.user.name,
            },
          }
        })

      const feed = {
        '?xml': {
          '@_version': '1.0',
          '@_encoding': 'utf8', // Changed 'UTF-8' to 'utf8' to satisfy the linter
        },
        feed: {
          '@_xmlns': 'http://www.w3.org/2005/Atom',
          'id':
            'https://twitter.com/search?q=' +
            encodeURIComponent(searchWord) +
            '&f=live',
          'title': key,
          'updated': new Date().toISOString(),
          'author': {
            'name': '', // Optionally set the author's name here
            'email': '', // Optionally set the author's email here
          },
          'link': [
            {
              '@_href':
                'https://twitter.com/search?q=' +
                encodeURIComponent(searchWord) +
                '&f=live',
              '@_rel': 'alternate',
            },
            {
              '@_href':
                'https://yourdomain.com/output/' +
                encodeURIComponent(sanitizeFileName(key)) +
                '.xml',
              '@_rel': 'self',
            },
          ],
          'generator': {
            '@_uri': 'https://yourappwebsite.com',
            '@_version': '1.0.0',
            '#text': 'YourAppName',
          },
          'entry': items,
        },
      }

      const xmlFeed = builder.build(feed)

      const filename = sanitizeFileName(key)
      fs.writeFileSync('output/' + filename + '.xml', xmlFeed)
      const endAt = new Date()
      logger.info(
        `📝 Generated: ${filename}.xml. Found ${items.length} items (${
          endAt.getTime() - startAt.getTime()
        }ms)`,
      )
    }
  } catch (error) {
    logger.error('Error', error as Error)
  } finally {
    await twitter.close()
  }
}

function generateList() {
  const logger = Logger.configure('generateList')
  logger.info('🚀 Generating list...')
  const files = fs.readdirSync('output')
  const template = fs.readFileSync('template.html', 'utf8')
  const list = files
    .map((file) => {
      if (!file.endsWith('.xml')) {
        return null
      }
      const parser = new XMLParser({
        ignoreAttributes: false,
      })

      // Define the AtomFeed interface
      interface AtomFeed {
        feed: {
          title: string
          subtitle?: string
          // Add other properties if needed
        }
      }

      const feedText = fs.readFileSync('output/' + file, 'utf8')
      const feed: AtomFeed = parser.parse(feedText)

      const title = feed.feed.title
      const description = feed.feed.subtitle || ''
      return `<li><a href='${encodeURIComponent(
        file,
      )}'>${title}</a>: <code>${description}</code></li>`
    })
    .filter((s) => s !== null)
  fs.writeFileSync(
    'output/index.html',
    template.replace('{{ RSS-FILES }}', '<ul>' + list.join('\n') + '</ul>'),
  )
  logger.info(`📝 Generated`)
}

async function main() {
  if (!fs.existsSync('output')) {
    fs.mkdirSync('output')
  }

  await generateRSS()
  generateList()

  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(0)
}

;(async () => {
  await main()
})()