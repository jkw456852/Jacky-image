import type { PromptGalleryData, PromptGalleryItem, PromptGallerySection } from '@/lib/prompt-gallery-types';

export interface PromptDataSource {
  name: string;
  url: string;
  sourceUrl: string;
  type: string;
  baseUrl?: string;
  caseFiles?: string[];
  modelTag?: string;
}

export type PromptWithKey = PromptGalleryItem & { uniqueKey: string };

export const PROMPT_DATA_SOURCES: PromptDataSource[] = [
  {
    name: 'nanobanana',
    url: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/unknowlei/nanobanana-website/refs/heads/main/public/data.json',
    sourceUrl: 'https://github.com/unknowlei/nanobanana-website',
    type: 'nanobanana',
  },
  {
    name: 'gpt-image-2-prompts',
    url: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main/data/ingested_tweets.json',
    sourceUrl: 'https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts',
    baseUrl: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main',
    type: 'gpt-image-2',
    caseFiles: ['README.md', 'cases/ad-creative.md', 'cases/character.md', 'cases/comparison.md', 'cases/ecommerce.md', 'cases/portrait.md', 'cases/poster.md', 'cases/ui.md'],
  },
  {
    name: 'awesome-gpt-image',
    url: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/README.zh-CN.md',
    sourceUrl: 'https://github.com/ZeroLu/awesome-gpt-image',
    baseUrl: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main',
    type: 'markdown-awesome',
  },
  {
    name: 'awesome-gpt4o-image-prompts',
    url: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main/README.zh-CN.md',
    sourceUrl: 'https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts',
    baseUrl: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main',
    type: 'markdown-gpt4o',
  },
  {
    name: 'youmind-gpt-image-2',
    url: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/README_zh.md',
    sourceUrl: 'https://github.com/YouMind-OpenLab/awesome-gpt-image-2',
    baseUrl: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main',
    type: 'markdown-youmind',
    modelTag: 'gpt-image-2',
  },
  {
    name: 'youmind-nano-banana-pro',
    url: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main/README_zh.md',
    sourceUrl: 'https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts',
    baseUrl: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main',
    type: 'markdown-youmind',
    modelTag: 'nano-banana-pro',
  },
  {
    name: 'davidwu-gpt-image2-prompts',
    url: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main/prompts.json',
    sourceUrl: 'https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts',
    baseUrl: 'https://proxy.ccode.vip/https/raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main',
    type: 'davidwu-json',
  },
];

export const DEFAULT_CATEGORIES = ['全部', '海报', '角色', '电商', 'UI', '风格转换', 'gpt-image-2', 'gpt4o', '其他'];

export const ALL_CATEGORY = '全部';

/** 从 GitHub 来源链接推导展示名（owner/repo），用于来源列表展示 */
export function getPromptSourceLabel(sourceUrl: string): string {
  return sourceUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
}

// --- Parsing utilities ---

export function inferCategory(title: string, content: string, tags: string[]): string {
  const text = `${title} ${content} ${tags.join(' ')}`.toLowerCase();
  if (text.includes('海报') || text.includes('poster')) return '海报';
  if (text.includes('角色') || text.includes('character') || text.includes('oc')) return '角色';
  if (text.includes('电商') || text.includes('商品') || text.includes('product')) return '电商';
  if (text.includes('ui') || text.includes('界面') || text.includes('设计')) return 'UI';
  if (text.includes('风格') || text.includes('转换') || text.includes('style')) return '风格转换';
  if (text.includes('gpt4o')) return 'gpt4o';
  if (text.includes('gpt-image-2')) return 'gpt-image-2';
  return '其他';
}

function splitBeforeHeading(markdown: string, prefix: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split('\n');
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith(prefix) && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }
  return blocks;
}

function firstMatch(value: string, pattern: RegExp): string {
  const match = value.match(pattern);
  return match && match[1] ? match[1] : '';
}

function absoluteImage(baseURL: string, image: string): string {
  if (!image) return '';
  if (image.startsWith('http://') || image.startsWith('https://')) return image;
  return `${baseURL}/${image.replace(/^\./, '').replace(/^\//, '')}`;
}

function extractMarkdownImages(baseURL: string, block: string): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  const patterns = [/<img[^>]+src="([^"]+)"/g, /!\[[^\]]*\]\(([^)]+)\)/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(block)) !== null) {
      const image = absoluteImage(baseURL, match[1]);
      if (image && !seen.has(image)) {
        seen.add(image);
        images.push(image);
      }
    }
  }
  return images;
}

function tagsFromHeading(heading: string): string[] {
  if (!heading) return [];
  return heading.replace(/[^\p{L}\p{N}/&、与 ]/gu, '').split(/\s*(\/|&|、|与)\s*/).map(t => t.trim().toLowerCase()).filter(Boolean);
}

function tagsFromCategory(category?: string): string[] {
  if (!category) return [];
  return category.replace(/\s+Cases$/i, '').split(/\s*(&|and)\s*/).map(t => t.trim()).filter(Boolean);
}

function youMindTags(title: string, modelTag: string): string[] {
  const tags = [modelTag];
  const parts = title.split(' - ', 2);
  if (parts.length > 1) {
    tags.push(...tagsFromHeading(parts[0]));
  }
  return tags;
}

function collectGptImage2Cases(cases: Record<string, string>, markdown: string) {
  const re = /### Case \d+: \[[^\]]+\]\(([^)]+)\).*?\*\*Prompt:\*\*\s*\r?\n\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    cases[match[1]] = match[2].trim();
  }
}

// --- Source-specific parsers ---

function parseNanobanana(json: unknown, source: PromptDataSource): PromptWithKey[] {
  const results: PromptWithKey[] = [];
  const data = json as PromptGalleryData;
  data.sections.forEach((section: PromptGallerySection, sectionIdx: number) => {
    section.prompts.forEach((prompt: PromptGalleryItem, promptIdx: number) => {
      const category = inferCategory(prompt.title, prompt.content, prompt.tags);
      results.push({
        ...prompt,
        source: source.name,
        sourceUrl: source.sourceUrl,
        category,
        uniqueKey: `${source.name}-${section.id}-${prompt.id}-${sectionIdx}-${promptIdx}`
      });
    });
  });
  return results;
}

async function parseGptImage2(source: PromptDataSource): Promise<PromptWithKey[]> {
  const cases: Record<string, string> = {};
  const res = await fetch(source.url);
  if (!res.ok) return [];
  const json = await res.json();

  if (source.caseFiles) {
    const markdownResults = await Promise.allSettled(
      source.caseFiles.map(file => fetch(`${source.baseUrl}/${file}`).then(r => r.ok ? r.text() : ''))
    );
    for (const result of markdownResults) {
      if (result.status === 'fulfilled' && result.value) {
        collectGptImage2Cases(cases, result.value);
      }
    }
  }

  const results: PromptWithKey[] = [];
  if (Array.isArray(json.records)) {
    json.records.forEach((record: { title?: string; tweet_url?: string; image_dir?: string; category?: string }, idx: number) => {
      if (!record.title) return;
      const promptText = cases[record.tweet_url || ''];
      if (!promptText) return;
      const imageUrl = `${source.baseUrl}/${record.image_dir}/output.jpg`;
      results.push({
        id: `gpt-image-2-${idx}`,
        title: record.title,
        content: promptText,
        images: [imageUrl],
        tags: tagsFromCategory(record.category),
        contributor: '',
        notes: '',
        source: source.name,
        sourceUrl: source.sourceUrl,
        category: 'gpt-image-2',
        uniqueKey: `${source.name}-${idx}`
      });
    });
  }
  return results;
}

async function parseMarkdownAwesome(source: PromptDataSource): Promise<PromptWithKey[]> {
  const res = await fetch(source.url);
  if (!res.ok) return [];
  const markdown = await res.text();
  const baseURL = source.baseUrl || '';
  const prompts: PromptWithKey[] = [];
  const sections = splitBeforeHeading(markdown, '## ');
  for (const section of sections) {
    const sectionTags = tagsFromHeading(firstMatch(section, /^##\s+(.+)$/m));
    const blocks = splitBeforeHeading(section, '### ');
    for (const block of blocks) {
      let title = firstMatch(block, /^###\s+(.+)$/m);
      title = title.replace(/\[([^\]]+)]\([^)]+\)/g, '$1').trim();
      const prompt = firstMatch(block, /\*\*提示词:\*\*\s*\r?\n\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```/);
      if (!title || !prompt) continue;
      const category = inferCategory(title, prompt, sectionTags);
      const idx = prompts.length;
      prompts.push({
        id: `${source.name}-${idx}`,
        title,
        content: prompt.trim(),
        images: extractMarkdownImages(baseURL, block),
        tags: sectionTags,
        contributor: '',
        notes: '',
        source: source.name,
        sourceUrl: source.sourceUrl,
        category,
        uniqueKey: `${source.name}-${idx}`,
      });
    }
  }
  return prompts;
}

async function parseMarkdownGpt4o(source: PromptDataSource): Promise<PromptWithKey[]> {
  const res = await fetch(source.url);
  if (!res.ok) return [];
  const markdown = await res.text();
  const baseURL = source.baseUrl || '';
  const prompts: PromptWithKey[] = [];
  const blocks = splitBeforeHeading(markdown, '### ');
  for (const block of blocks) {
    const title = firstMatch(block, /^###\s+(.+)$/m).trim();
    const prompt = firstMatch(block, /- \*\*提示词文本：\*\*\s*`([\s\S]*?)`/);
    if (!title || !prompt) continue;
    const idx = prompts.length;
    prompts.push({
      id: `${source.name}-${idx}`,
      title,
      content: prompt.trim(),
      images: extractMarkdownImages(baseURL, block),
      tags: ['gpt4o'],
      contributor: '',
      notes: '',
      source: source.name,
      sourceUrl: source.sourceUrl,
      category: 'gpt4o',
      uniqueKey: `${source.name}-${idx}`,
    });
  }
  return prompts;
}

async function parseMarkdownYouMind(source: PromptDataSource): Promise<PromptWithKey[]> {
  const res = await fetch(source.url);
  if (!res.ok) return [];
  const markdown = await res.text();
  const baseURL = source.baseUrl || '';
  const modelTag = source.modelTag || '';
  const prompts: PromptWithKey[] = [];
  const blocks = splitBeforeHeading(markdown, '### ');
  for (const block of blocks) {
    const title = firstMatch(block, /^###\s+No\.\s*\d+:\s*(.+)$/m).trim();
    const prompt = firstMatch(block, /#### .*?提示词\s*\r?\n\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```/);
    if (!title || !prompt) continue;
    const tags = youMindTags(title, modelTag);
    const category = inferCategory(title, prompt, tags);
    const idx = prompts.length;
    prompts.push({
      id: `${source.name}-${idx}`,
      title,
      content: prompt.trim(),
      images: extractMarkdownImages(baseURL, block),
      tags,
      contributor: '',
      notes: '',
      source: source.name,
      sourceUrl: source.sourceUrl,
      category,
      uniqueKey: `${source.name}-${idx}`,
    });
  }
  return prompts;
}

interface DavidWuItem {
  id?: string;
  title_cn?: string;
  title_en?: string;
  prompt?: string;
  image?: string;
  category_cn?: string;
  category?: string;
  author?: string;
  source?: string;
  needs_ref?: boolean;
  note?: string;
}

async function parseDavidWuJson(source: PromptDataSource): Promise<PromptWithKey[]> {
  const res = await fetch(source.url);
  if (!res.ok) return [];
  const json = await res.json();
  if (!Array.isArray(json)) return [];
  const baseURL = source.baseUrl || '';
  const prompts: PromptWithKey[] = [];
  for (const item of json as DavidWuItem[]) {
    const title = item.title_cn?.trim() || item.title_en?.trim();
    if (!title) continue;
    const prompt = item.prompt?.trim();
    if (!prompt) continue;
    const image = absoluteImage(baseURL, item.image || '');
    const tags: string[] = [];
    if (item.category_cn) tags.push(item.category_cn);
    if (item.category) tags.push(item.category);
    if (item.author) tags.push(item.author);
    if (item.source) tags.push(item.source);
    if (item.needs_ref) tags.push('需要参考图');
    const category = inferCategory(title, prompt, tags);
    const idx = prompts.length;
    prompts.push({
      id: `${source.name}-${item.id || idx}`,
      title,
      content: prompt,
      images: image ? [image] : [],
      tags: tags.filter(Boolean),
      contributor: item.author || '',
      notes: item.note || '',
      source: source.name,
      sourceUrl: source.sourceUrl,
      category,
      uniqueKey: `${source.name}-${idx}`,
    });
  }
  return prompts;
}

// --- Fetch all sources in parallel ---

function fetchSource(source: PromptDataSource): Promise<PromptWithKey[]> {
  switch (source.type) {
    case 'nanobanana':
      return fetch(source.url)
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(json => parseNanobanana(json, source));
    case 'gpt-image-2':
      return parseGptImage2(source);
    case 'markdown-awesome':
      return parseMarkdownAwesome(source);
    case 'markdown-gpt4o':
      return parseMarkdownGpt4o(source);
    case 'markdown-youmind':
      return parseMarkdownYouMind(source);
    case 'davidwu-json':
      return parseDavidWuJson(source);
    default:
      return Promise.resolve([]);
  }
}

export interface FetchResult {
  prompts: PromptWithKey[];
  categories: string[];
}

export async function fetchAllPromptSources(): Promise<FetchResult> {
  const settled = await Promise.allSettled(
    PROMPT_DATA_SOURCES.map(source => fetchSource(source))
  );

  const categorySet = new Set<string>(DEFAULT_CATEGORIES.filter(c => c !== ALL_CATEGORY));
  const prompts: PromptWithKey[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      for (const p of result.value) {
        if (p.category) categorySet.add(p.category);
        prompts.push(p);
      }
    }
  }

  return {
    prompts,
    categories: [ALL_CATEGORY, ...Array.from(categorySet)],
  };
}
