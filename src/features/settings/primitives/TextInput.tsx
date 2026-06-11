import { Input } from "@/components/ui/input";

export function TextInput({
  value,
  onChange,
  type = "text",
  list,
  disabled,
  autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  list?: string;
  disabled?: boolean;
  autoComplete?: string;
}) {
  return (
    <Input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono"
      list={list}
      disabled={disabled}
      autoComplete={autoComplete}
    />
  );
}
