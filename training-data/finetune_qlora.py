"""
DigiPin DISHA — QLoRA Fine-Tuning Script
=========================================
Fine-tunes Qwen2.5-7B (or any HF model) on urban intelligence Q&A pairs
using 4-bit QLoRA via Unsloth for fast, memory-efficient training.

Requirements:
    pip install "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
    pip install --no-deps trl peft accelerate bitsandbytes xformers

Usage:
    python finetune_qlora.py                          # defaults
    python finetune_qlora.py --epochs 5 --lr 2e-4     # custom
    python finetune_qlora.py --model unsloth/llama-3.1-8b-bnb-4bit  # different base

After training, convert to GGUF and import into Ollama:
    python finetune_qlora.py --export_gguf
    ollama create disha -f ../Modelfile
"""

import argparse
import json
import os
from pathlib import Path


def load_alpaca_dataset(path: str):
    """Load Alpaca-format JSON training data."""
    from datasets import Dataset

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    print(f"Loaded {len(data)} training pairs from {path}")
    return Dataset.from_list(data)


def format_prompt(example: dict) -> dict:
    """Format into Alpaca instruction template for training."""
    TEMPLATE = """Below is an instruction that describes an urban analysis task, paired with context data from India's DigiPin system. Write a response that appropriately completes the request.

### Instruction:
{instruction}

### Input:
{input}

### Response:
{output}"""

    return {
        "text": TEMPLATE.format(
            instruction=example["instruction"],
            input=example["input"],
            output=example["output"],
        )
    }


def main():
    parser = argparse.ArgumentParser(description="DigiPin DISHA QLoRA Fine-Tuning")
    parser.add_argument(
        "--model",
        default="unsloth/Qwen2.5-7B-bnb-4bit",
        help="Base model (HF or unsloth 4-bit quantized)",
    )
    parser.add_argument(
        "--data",
        default=str(Path(__file__).parent / "digipin-alpaca.json"),
        help="Path to Alpaca-format training data",
    )
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate")
    parser.add_argument("--batch_size", type=int, default=4, help="Per-device batch size")
    parser.add_argument(
        "--grad_accum", type=int, default=4, help="Gradient accumulation steps"
    )
    parser.add_argument("--max_seq_len", type=int, default=4096, help="Max sequence length")
    parser.add_argument("--lora_r", type=int, default=16, help="LoRA rank")
    parser.add_argument("--lora_alpha", type=int, default=16, help="LoRA alpha")
    parser.add_argument(
        "--output_dir",
        default=str(Path(__file__).parent / "disha-qlora-output"),
        help="Output directory for checkpoints",
    )
    parser.add_argument(
        "--export_gguf",
        action="store_true",
        help="Export to GGUF Q4_K_M after training",
    )
    args = parser.parse_args()

    # ── 1. Load model with QLoRA ──
    from unsloth import FastLanguageModel

    print(f"\n{'='*60}")
    print(f"  DigiPin DISHA Fine-Tuning")
    print(f"  Model: {args.model}")
    print(f"  Data:  {args.data}")
    print(f"  Epochs: {args.epochs} | LR: {args.lr} | Batch: {args.batch_size}x{args.grad_accum}")
    print(f"{'='*60}\n")

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_len,
        dtype=None,  # auto-detect (float16 on GPU)
        load_in_4bit=True,
    )

    # ── 2. Add LoRA adapters ──
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=args.lora_alpha,
        lora_dropout=0,  # unsloth optimized — 0 is faster
        bias="none",
        use_gradient_checkpointing="unsloth",  # 30% less VRAM
        random_state=42,
    )

    trainable, total = model.get_nb_trainable_parameters()
    print(f"Trainable: {trainable:,} / {total:,} ({100*trainable/total:.2f}%)\n")

    # ── 3. Load and format dataset ──
    dataset = load_alpaca_dataset(args.data)
    dataset = dataset.map(format_prompt, remove_columns=dataset.column_names)

    print(f"Sample prompt (first 500 chars):\n{dataset[0]['text'][:500]}...\n")

    # ── 4. Train with SFTTrainer ──
    from trl import SFTTrainer
    from transformers import TrainingArguments

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=args.max_seq_len,
        dataset_num_proc=2,
        packing=True,  # pack short sequences together for efficiency
        args=TrainingArguments(
            output_dir=args.output_dir,
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=args.grad_accum,
            warmup_steps=10,
            num_train_epochs=args.epochs,
            learning_rate=args.lr,
            fp16=True,
            logging_steps=5,
            save_strategy="epoch",
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="cosine",
            seed=42,
            report_to="none",
        ),
    )

    print("Starting training...\n")
    stats = trainer.train()
    print(f"\nTraining complete! Loss: {stats.training_loss:.4f}")
    print(f"Runtime: {stats.metrics['train_runtime']:.0f}s")

    # ── 5. Save LoRA adapter ──
    lora_dir = os.path.join(args.output_dir, "lora-adapter")
    model.save_pretrained(lora_dir)
    tokenizer.save_pretrained(lora_dir)
    print(f"\nLoRA adapter saved to: {lora_dir}")

    # ── 6. Export to GGUF (optional) ──
    if args.export_gguf:
        gguf_dir = os.path.join(args.output_dir, "gguf")
        print(f"\nExporting to GGUF Q4_K_M → {gguf_dir}")
        model.save_pretrained_gguf(
            gguf_dir,
            tokenizer,
            quantization_method="q4_k_m",
        )
        print(f"GGUF export complete!")
        print(f"\nTo import into Ollama:")
        print(f"  1. Update Modelfile FROM path to: {gguf_dir}")
        print(f"  2. Run: ollama create disha -f ../Modelfile")
        print(f"  3. Test: ollama run disha")


if __name__ == "__main__":
    main()
