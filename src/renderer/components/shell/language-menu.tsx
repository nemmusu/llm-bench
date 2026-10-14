import { ChevronDown, Globe } from 'lucide-react';
import { LANGUAGE_NAMES, LANGUAGES, useI18n, type Lang } from '../../i18n';
import { cn } from '../../lib/cn';
import { useSettings } from '../../lib/settings';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { SegmentedControl } from '../ui/segmented-control';

/**
 * Title bar: a globe with the current language ("English", "Italiano"); the menu lists every
 * language in its own words and switches at once (the tray menu follows through the settings).
 */
export function LanguageMenu() {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  const name = LANGUAGE_NAMES[settings.language];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('language.menu', { name })} className="gap-1.5 px-2">
          <Globe aria-hidden />
          <span>{name}</span>
          <ChevronDown aria-hidden className="text-fg-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-44">
        <DropdownMenuLabel>{t('language.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={settings.language} onValueChange={(v) => update({ language: v as Lang })}>
          {LANGUAGES.map((lang) => (
            <DropdownMenuRadioItem key={lang} value={lang} lang={lang}>
              {LANGUAGE_NAMES[lang]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same choice as one-click segments (the welcome screen, where an Italian reader starts in English). */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t } = useI18n();
  const { settings, update } = useSettings();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Globe aria-hidden className="size-4 text-fg-3" />
      <SegmentedControl
        label={t('language.label')}
        size="sm"
        value={settings.language}
        onValueChange={(language) => update({ language })}
        options={LANGUAGES.map((lang) => ({ value: lang, label: <span lang={lang}>{LANGUAGE_NAMES[lang]}</span> }))}
      />
    </div>
  );
}
