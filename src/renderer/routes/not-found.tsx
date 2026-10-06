import { Link } from '@tanstack/react-router';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { useI18n } from '../i18n';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="grid min-h-full place-items-center">
      <EmptyState
        illustration="search"
        title={t('empty.notFoundTitle')}
        description={t('empty.notFoundBody')}
        action={
          <Button variant="primary" asChild>
            <Link to="/">{t('empty.goHome')}</Link>
          </Button>
        }
      />
    </div>
  );
}
