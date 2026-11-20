import { Component, type ErrorInfo, type ReactNode } from 'react';

/** A rendering failure must not leave an empty window: say what happened and offer a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error('MORA UI error', error, info.componentStack); }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="ui-crash" role="alert">
        <h1>Что-то пошло не так</h1>
        <p>Интерфейс столкнулся с ошибкой. Музыка и медиатека не пострадали.</p>
        <pre>{this.state.error.message}</pre>
        <div className="ui-crash-actions">
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Попробовать снова</button>
          <button className="btn btn-ghost" onClick={() => location.reload()}>Перезагрузить MORA</button>
        </div>
      </div>
    );
  }
}
