import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LoaderCircle, Users, X } from "lucide-react";

export function Icon({
  icon: Component,
  size = 18,
  ...props
}: {
  icon: typeof Users;
  size?: number;
  className?: string;
}) {
  return (
    <Component size={size} strokeWidth={1.7} aria-hidden="true" {...props} />
  );
}
export function Button({
  children,
  icon,
  variant = "secondary",
  className = "",
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: typeof Users;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
    >
      {busy ? (
        <Icon icon={LoaderCircle} className="spin" />
      ) : icon ? (
        <Icon icon={icon} size={16} />
      ) : null}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  icon,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: typeof Users;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon icon={icon} size={17} />
    </button>
  );
}
export function Dialog({
  title,
  description,
  children,
  onClose,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      requestAnimationFrame(() => previous?.focus());
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <IconButton icon={X} label="关闭" onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
