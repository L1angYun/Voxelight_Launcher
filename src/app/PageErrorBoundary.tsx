import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

type PageErrorBoundaryProps = {
  page: string;
  title: string;
  description: string;
  retryLabel: string;
  children?: ReactNode;
};

type PageErrorBoundaryState = {
  message: string | null;
};

export class PageErrorBoundary extends Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return {
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      `[Voxelight] page "${this.props.page}" failed to render`,
      error,
      info.componentStack,
    );
  }

  private retry = () => {
    this.setState({ message: null });
  };

  render() {
    if (this.state.message !== null) {
      return (
        <section
          className="vx-page-error"
          data-page-error={this.props.page}
          role="alert"
        >
          <h1>{this.props.title}</h1>
          <p>{this.props.description}</p>
          <code>{this.state.message}</code>
          <button type="button" onClick={this.retry}>
            {this.props.retryLabel}
          </button>
        </section>
      );
    }

    return this.props.children;
  }
}
