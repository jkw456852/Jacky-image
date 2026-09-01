import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';

interface UseImageLazyLoadOptions {
    /** 图片加载前的占位符高度（像素） */
    placeholderHeight?: number;
    /** 提前加载的边距（像素），图片进入此范围即开始加载 */
    rootMargin?: string;
    /** 是否启用懒加载（false 时立即加载） */
    enabled?: boolean;
}

/**
 * 图片懒加载 Hook
 * 使用 IntersectionObserver 实现图片进入视口时才加载
 * 返回加载状态和 ref，用于控制图片渲染时机
 */
export function useImageLazyLoad<T extends HTMLElement = HTMLDivElement>({
    placeholderHeight = 200,
    rootMargin = '200px',
    enabled = true,
}: UseImageLazyLoadOptions = {}) {
    const [isVisible, setIsVisible] = useState(!enabled);
    const [isLoaded, setIsLoaded] = useState(!enabled);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const elementRef = useRef<T>(null) as RefObject<T | null>;

    // 创建 IntersectionObserver
    useEffect(() => {
        if (!enabled || !elementRef.current) return;

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        setIsVisible(true);
                        // 元素进入视口后停止观察
                        observer.unobserve(entry.target);
                    }
                });
            },
            {
                rootMargin,
                threshold: 0.01,
            }
        );

        observer.observe(elementRef.current);
        observerRef.current = observer;

        return () => {
            observer.disconnect();
            observerRef.current = null;
        };
    }, [enabled, rootMargin]);

    // 监听图片加载完成
    const handleImageLoad = useCallback(() => {
        setIsLoaded(true);
    }, []);

    return {
        /** 元素引用，需要绑定到占位符容器上 */
        elementRef,
        /** 元素是否已进入视口 */
        isVisible,
        /** 图片是否已加载完成 */
        isLoaded,
        /** 占位符高度 */
        placeholderHeight,
        /** 图片加载完成回调，绑定到 img 的 onLoad */
        handleImageLoad,
    };
}
