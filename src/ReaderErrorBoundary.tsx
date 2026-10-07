import { Component, type ReactNode } from 'react';

interface ReaderErrorBoundaryProps {
  onBack: () => void;
  children: ReactNode;
}

interface ReaderErrorBoundaryState {
  error: Error | null;
}

/**
 * Without this, any uncaught render error inside the reader (a corrupted
 * settings value reaching an unconditional lookup, say) unmounts the whole
 * React tree with no feedback at all - a blank white screen that reopens
 * blank on every future launch too, since React's default behavior on an
 * uncaught error is to discard the entire tree rather than isolate it to
 * the subtree that actually failed. Catching it here means there's always
 * a working Back button, whatever broke underneath it.
 */
export default class ReaderErrorBoundary extends Component<ReaderErrorBoundaryProps, ReaderErrorBoundaryState> {
  state: ReaderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ReaderErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ReaderErrorBoundary] caught render error', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="reader-error-screen">
          <p className="error">Something went wrong showing this book.</p>
          <button className="icon-button" onClick={this.props.onBack}>
            Back to library
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
