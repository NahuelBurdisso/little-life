import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-red-950 text-white flex flex-col items-center justify-center gap-4 p-8">
          <h1 className="text-2xl font-bold text-red-400">Something went wrong</h1>
          <pre className="text-sm text-red-300 bg-red-900/50 p-4 rounded max-w-2xl overflow-auto">
            {this.state.error?.message}
          </pre>
          <pre className="text-xs text-red-400/70 bg-red-900/30 p-4 rounded max-w-2xl overflow-auto max-h-64">
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded"
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
