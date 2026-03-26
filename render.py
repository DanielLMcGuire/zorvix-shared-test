import argparse
import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

def plot_csv(input_path, output_path):
    df = pd.read_csv(input_path)

    label_col = df.columns[0]
    value_cols = df.columns[1:]

    df = df[df[label_col].str.upper() != "TOTAL"]

    labels = df[label_col]
    x = np.arange(len(labels))

    width = 0.8 / len(value_cols)

    plt.figure(figsize=(14, 7))

    for i, col in enumerate(value_cols):
        plt.bar(x + (i - len(value_cols)/2) * width + width/2,
                df[col],
                width,
                label=col)

    plt.xlabel(label_col)
    plt.ylabel("Requests per second")
    plt.title("Benchmark")
    plt.xticks(x, labels, rotation=45, ha="right")
    plt.legend()

    plt.tight_layout()
    plt.savefig(output_path, format="svg")
    plt.close()

def main():
    parser = argparse.ArgumentParser(description="Render results into graph")
    parser.add_argument("-i", "--input", required=True, help="Path to input CSV file")
    parser.add_argument("-o", "--output", default="output.svg", help="Output SVG file")
    args = parser.parse_args()

    plot_csv(args.input, args.output)

if __name__ == "__main__":
    main()
