import { Button } from '../components/ui/button.js';
import { ProductErrorIcon } from './product-error-icon.js';

type AnalyticsErrorCardProps = {
  message: string;
  onRetry: () => void;
  isRetrying: boolean;
};

/** D6: keep loading failures visible, announced and recoverable in their card. */
export function AnalyticsErrorCard({ message, onRetry, isRetrying }: AnalyticsErrorCardProps) {
  return (
    <div className="panel notice warning analytics-error-card" role="alert">
      <ProductErrorIcon />
      <div className="analytics-error-content">
        <p>{message}</p>
        <Button disabled={isRetrying} onClick={onRetry}>
          {isRetrying ? 'Tentando…' : 'Tentar novamente'}
        </Button>
      </div>
    </div>
  );
}
