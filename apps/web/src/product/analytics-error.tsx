import { Button } from '../components/ui/button.js';
import { ProductErrorIcon } from './product-error-icon.js';

type AnalyticsErrorCardProps = {
  message: string;
  onRetry: () => void;
};

/** D6: keep loading failures visible, announced and recoverable in their card. */
export function AnalyticsErrorCard({ message, onRetry }: AnalyticsErrorCardProps) {
  return (
    <div className="panel notice warning analytics-error-card" role="alert">
      <ProductErrorIcon />
      <div className="analytics-error-content">
        <p>{message}</p>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}
