interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export default function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  return (
    <div>
      <h2>Prepare failed</h2>
      <p>{message}</p>
      <button onClick={onRetry}>Try again</button>
    </div>
  );
}
