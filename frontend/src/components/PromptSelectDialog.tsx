'use client';

import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { Search, Loader2, Check, ExternalLink } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchAllPromptSources, DEFAULT_CATEGORIES, ALL_CATEGORY, type PromptWithKey } from '@/lib/prompt-gallery-data';

const PAGE_SIZE = 12;

interface PromptSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (prompt: string) => void;
}

export const PromptSelectDialog = memo(function PromptSelectDialog({
  open,
  onOpenChange,
  onSelect,
}: PromptSelectDialogProps) {
  const [allPrompts, setAllPrompts] = useState<PromptWithKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORY);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    fetchAllPromptSources()
      .then(result => {
        setCategories(result.categories);
        setAllPrompts(result.prompts);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [open]);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setSelectedCategory(ALL_CATEGORY);
      setDisplayCount(PAGE_SIZE);
    }
  }, [open]);

  const filteredPrompts = useMemo(() => {
    let prompts = allPrompts;

    const hasChinese = (text: string) => /[\u4e00-\u9fa5]/.test(text);
    prompts = prompts.filter(p => hasChinese(p.title) || hasChinese(p.content));

    if (selectedCategory !== ALL_CATEGORY) {
      prompts = prompts.filter(p => p.category === selectedCategory);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      prompts = prompts.filter(p =>
        p.title.toLowerCase().includes(query) ||
        p.content.toLowerCase().includes(query)
      );
    }

    return prompts;
  }, [allPrompts, searchQuery, selectedCategory]);

  const displayedPrompts = useMemo(() => {
    return filteredPrompts.slice(0, displayCount);
  }, [filteredPrompts, displayCount]);

  const hasMore = displayCount < filteredPrompts.length;

  useEffect(() => {
    if (!loadMoreRef.current || !open) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && displayCount < filteredPrompts.length) {
          setDisplayCount(prev => Math.min(prev + PAGE_SIZE, filteredPrompts.length));
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(loadMoreRef.current);

    return () => observer.disconnect();
  }, [displayCount, filteredPrompts.length, open]);

  const handleSelect = useCallback((prompt: PromptWithKey) => {
    onSelect(prompt.content);
    onOpenChange(false);
  }, [onSelect, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            提示词库
            <span className="text-sm text-muted-foreground">
              ({filteredPrompts.length} 条)
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="搜索提示词..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {categories.map(category => (
              <Badge
                key={category}
                variant={selectedCategory === category ? 'default' : 'secondary'}
                className="cursor-pointer px-3 py-1 transition-colors hover:bg-primary/80"
                onClick={() => setSelectedCategory(category)}
              >
                {category}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : displayedPrompts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              没有找到匹配的提示词
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-1">
              {displayedPrompts.map(prompt => (
                <div
                  key={prompt.uniqueKey}
                  className="bg-muted/50 border border-border rounded-lg p-3 cursor-pointer hover:bg-muted transition-colors"
                  onClick={() => handleSelect(prompt)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium text-sm line-clamp-1">{prompt.title}</h3>
                    {prompt.images[0] && (
                      <img
                        src={prompt.images[0]}
                        alt={prompt.title}
                        className="w-12 h-12 rounded object-cover flex-shrink-0"
                      />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-1.5">
                    {prompt.content}
                  </p>
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-1">
                      {prompt.category && (
                        <Badge variant="outline" className="text-xs px-1.5 py-0">
                          {prompt.category}
                        </Badge>
                      )}
                      {prompt.sourceUrl && (
                        <a
                          href={prompt.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="来源"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    <Button variant="ghost" size="xs" className="h-6 px-2">
                      <Check className="w-3 h-3 mr-1" />
                      使用
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {hasMore && (
            <div ref={loadMoreRef} className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
});
