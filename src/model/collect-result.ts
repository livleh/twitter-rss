export interface Item {
  id: string
  title: string
  updated: string
  content: string
  link: {
    '@_href': string
  }
  published?: string
  author?: {
    name: string
  }
}

export default interface CollectResult {
  status: boolean
  items: Item[]
}