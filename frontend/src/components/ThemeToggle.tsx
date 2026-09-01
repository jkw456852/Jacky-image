'use client';

import { useState, useEffect } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getDesktopPreference, setDesktopPreference } from '@/lib/desktop-preferences';

type Theme = 'light' | 'dark' | 'system';

const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

function applyTheme(newTheme: Theme) {
  const root = document.documentElement;
  if (newTheme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', newTheme);
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      setMounted(true);
      try {
        const stored = getDesktopPreference('theme');
        if (!isTheme(stored)) return;
        setTheme(stored);
        applyTheme(stored);
      } catch {
        applyTheme('system');
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectTheme = (newTheme: string) => {
    if (!isTheme(newTheme)) return;
    setTheme(newTheme);
    try {
      setDesktopPreference('theme', newTheme);
    } catch {
      // Storage can be unavailable in hardened/private browser modes.
    }
    applyTheme(newTheme);
  };

  if (!mounted) {
    return (
      <Button variant="outline" size="icon" aria-label="切换主题">
        <div className="w-5 h-5" />
      </Button>
    );
  }

  const currentOption = themeOptions.find(o => o.value === theme)!;
  const CurrentIcon = currentOption.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-0 px-2 sm:gap-2 sm:px-3")}
        title={`主题：${currentOption.label}`}
        aria-label="切换主题"
      >
        <CurrentIcon className="size-4" />
        <span className="hidden sm:inline">{currentOption.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuRadioGroup value={theme} onValueChange={selectTheme}>
          {themeOptions.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <Icon className="size-4" />
                {option.label}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
